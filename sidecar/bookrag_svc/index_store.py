# -*- coding: utf-8 -*-
"""Per-document TGM index: tree, entity graph, BM25 and dense vectors."""
from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path

import numpy as np

from .bm25 import BM25
from .chunker import chunk_sections
from .graph import build_graph, extract_entities
from .parsers import sections_for


def _atomic_json(path: Path, payload) -> None:
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    os.replace(tmp, path)


def _node_text(node: dict, title: str) -> str:
    path = " > ".join(node.get("section_path") or [])
    return f"{title} | {path}\n{node['text']}"


def build_document(
    *,
    doc_id: str,
    doc_record: dict,
    source_path: Path,
    doc_dir: Path,
    max_chars: int = 520,
    overlap: int = 80,
    embedder=None,
    progress=lambda _message, _fraction: None,
) -> dict:
    doc_dir.mkdir(parents=True, exist_ok=True)
    title = doc_record.get("title") or doc_id
    progress("解析文档", 0.05)
    sections = sections_for(source_path, doc_dir)
    progress(f"解析完成：{len(sections)} 个章节/页", 0.2)

    nodes = chunk_sections(sections, max_chars=max_chars, overlap=overlap)
    if not nodes:
        raise RuntimeError("document produced no chunks")
    for node in nodes:
        local = node["id"]
        node["id"] = f"{doc_id}:{local}"
        node["prev"] = f"{doc_id}:{node['prev']}" if node.get("prev") else None
        node["next"] = f"{doc_id}:{node['next']}" if node.get("next") else None
    progress(f"切块完成：{len(nodes)} 个知识单元", 0.3)

    graph = build_graph(nodes)
    progress(f"实体图完成：{len(graph['entities'])} 个实体 / {len(graph['edges'])} 条边", 0.5)

    bm25 = BM25()
    bm25.add_docs(nodes, lambda node: _node_text(node, title))
    progress("BM25 完成", 0.6)

    vectors = None
    embedder_info = {"model": None, "dim": None, "enabled": False}
    if embedder is not None and getattr(embedder, "enabled", False):
        texts = [_node_text(node, title) for node in nodes]
        batches: list[np.ndarray] = []
        batch_size = max(1, int(getattr(embedder, "batch_size", 16)))
        for start in range(0, len(texts), batch_size):
            batch = texts[start : start + batch_size]
            encoded = embedder.encode(batch)
            if encoded is None:
                raise RuntimeError("embedding model is not available")
            batches.append(encoded)
            progress(f"向量化 {min(len(texts), start + len(batch))}/{len(texts)}", 0.6 + 0.35 * min(1.0, (start + len(batch)) / max(1, len(texts))))
        vectors = np.vstack(batches).astype(np.float32)
        embedder_info = {
            "model": Path(str(getattr(embedder, "model_path", ""))).name,
            "dim": int(vectors.shape[1]),
            "enabled": True,
        }
    progress("向量化完成" if vectors is not None else "跳过向量化（未配置模型）", 0.95)

    _atomic_json(doc_dir / "tree.json", nodes)
    _atomic_json(doc_dir / "graph.json", graph)
    bm25.save(str(doc_dir / "bm25.json.gz"))
    if vectors is not None:
        np.save(doc_dir / "vectors.npy", vectors)
    _atomic_json(
        doc_dir / "meta.json",
        {
            "docId": doc_id,
            "title": title,
            "chunkMaxChars": max_chars,
            "overlap": overlap,
            "nodes": len(nodes),
            "entities": len(graph["entities"]),
            "edges": len(graph["edges"]),
            "embedder": embedder_info,
            "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        },
    )
    return {
        "nodes": len(nodes),
        "entities": len(graph["entities"]),
        "edges": len(graph["edges"]),
        "chunks": len(nodes),
        "embedder": embedder_info,
    }


class DocIndex:
    def __init__(self, meta: dict, nodes: list[dict], graph: dict, bm25: BM25, vectors: np.ndarray | None):
        self.meta = meta
        self.nodes = nodes
        self.graph = graph
        self.bm25 = bm25
        self.vectors = vectors
        self.doc_id = meta.get("docId")
        self.node_map = {node["id"]: node for node in nodes}
        self.node_index = {node["id"]: index for index, node in enumerate(nodes)}
        self._adj: dict[str, list[tuple[str, int]]] = {}
        for left, right, weight in graph.get("edges", []):
            self._adj.setdefault(left, []).append((right, weight))
            self._adj.setdefault(right, []).append((left, weight))

    @classmethod
    def load(cls, doc_dir: Path) -> "DocIndex":
        meta = json.loads((doc_dir / "meta.json").read_text(encoding="utf-8"))
        nodes = json.loads((doc_dir / "tree.json").read_text(encoding="utf-8"))
        graph = json.loads((doc_dir / "graph.json").read_text(encoding="utf-8"))
        bm25 = BM25.load(str(doc_dir / "bm25.json.gz"))
        vector_path = doc_dir / "vectors.npy"
        vectors = np.load(vector_path).astype(np.float32) if vector_path.exists() else None
        return cls(meta, nodes, graph, bm25, vectors)

    def node(self, node_id: str) -> dict | None:
        return self.node_map.get(node_id)

    def dense_search(self, query_vector: np.ndarray | None, top_k: int = 30) -> list[tuple[str, float]]:
        if self.vectors is None or query_vector is None or len(self.nodes) == 0:
            return []
        similarities = self.vectors @ query_vector
        count = min(top_k, len(similarities))
        top = np.argpartition(-similarities, count - 1)[:count]
        ordered = sorted(top.tolist(), key=lambda index: float(similarities[index]), reverse=True)
        return [(self.nodes[index]["id"], float(similarities[index])) for index in ordered]

    def bm25_search(self, query: str, top_k: int = 30) -> list[tuple[str, float]]:
        return self.bm25.search(query, top_k=top_k)

    def tgm_search(self, query: str, top_k: int = 30) -> list[dict]:
        query_entities = [value for _, value in extract_entities(query, strict=False)]
        mapping = self.graph.get("mapping", {})
        scores: dict[str, float] = {}
        matched: dict[str, list[str]] = {}
        via: dict[str, str] = {}
        for entity in query_entities:
            for node_id in mapping.get(entity, []):
                scores[node_id] = scores.get(node_id, 0.0) + 3.0
                matched.setdefault(node_id, []).append(entity)
                via[node_id] = "direct"
        for entity in query_entities:
            for neighbour, weight in self._adj.get(entity, []):
                if weight < 2:
                    continue
                for node_id in mapping.get(neighbour, []):
                    if node_id in scores:
                        continue
                    scores[node_id] = scores.get(node_id, 0.0) + 1.5
                    matched.setdefault(node_id, []).append(f"{entity}→{neighbour}")
                    via[node_id] = "neighbor"
        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)[:top_k]
        return [
            {"id": node_id, "score": score, "matched": matched.get(node_id, []), "via": via.get(node_id, "tgm")}
            for node_id, score in ranked
        ]

    def stats(self) -> dict:
        return {
            "docId": self.doc_id,
            "nodes": len(self.nodes),
            "entities": len(self.graph.get("entities", [])),
            "edges": len(self.graph.get("edges", [])),
            "vectors": None if self.vectors is None else list(self.vectors.shape),
        }