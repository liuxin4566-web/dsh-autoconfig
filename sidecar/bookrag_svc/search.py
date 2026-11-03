# -*- coding: utf-8 -*-
"""Cross-document hybrid retrieval: dense + BM25 + TGM, fused with RRF."""
from __future__ import annotations

import threading
import time
from pathlib import Path

import numpy as np

from .config import Settings
from .embedder import Embedder
from .index_store import DocIndex, build_document
from .manifest import Manifest, match_document


def _locator(node: dict) -> str:
    page = node.get("page")
    if page:
        return f"第 {page} 页"
    start = int(node.get("start_line") or 0)
    end = int(node.get("end_line") or 0)
    return f"L{start}-L{end}" if start else ""


def _trim(text: str, limit: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


class Registry:
    def __init__(self, settings: Settings, embedder: Embedder, reranker=None):
        self.settings = settings
        self.embedder = embedder
        self.reranker = reranker
        self.manifest = Manifest(settings.manifest_path)
        self.indexes: dict[str, DocIndex] = {}
        self._lock = threading.RLock()
        self._load_errors: dict[str, str] = {}

    # ── lifecycle ────────────────────────────────────────────────────────────
    def load_all(self) -> None:
        with self._lock:
            self.indexes.clear()
            self._load_errors.clear()
            for record in self.manifest.list():
                if record.get("status") != "ready":
                    continue
                try:
                    self.indexes[record["docId"]] = DocIndex.load(self.settings.docs_dir / record["docId"])
                except Exception as error:  # keep serving the remaining docs
                    self._load_errors[record["docId"]] = str(error)

    def reload(self, doc_id: str) -> None:
        with self._lock:
            try:
                self.indexes[doc_id] = DocIndex.load(self.settings.docs_dir / doc_id)
                self._load_errors.pop(doc_id, None)
            except Exception as error:
                self._load_errors[doc_id] = str(error)

    def drop(self, doc_id: str) -> None:
        with self._lock:
            self.indexes.pop(doc_id, None)

    # ── build ────────────────────────────────────────────────────────────────
    def build(self, doc_id: str, progress=lambda _message, _fraction: None) -> dict:
        record = self.manifest.get(doc_id)
        if record is None:
            raise RuntimeError(f"unknown document: {doc_id}")
        doc_dir = self.settings.docs_dir / doc_id
        stored = record.get("storedFile") or "source.md"
        source_path = doc_dir / stored
        if not source_path.exists():
            raise RuntimeError(f"source file missing: {source_path}")
        self.manifest.update(doc_id, status="building", error=None)
        try:
            stats = build_document(
                doc_id=doc_id,
                doc_record=record,
                source_path=source_path,
                doc_dir=doc_dir,
                max_chars=self.settings.chunk_max_chars,
                overlap=self.settings.chunk_overlap,
                embedder=self.embedder,
                progress=progress,
            )
            self.manifest.update(doc_id, status="ready", stats=stats, builtAt=time.strftime("%Y-%m-%dT%H:%M:%S"), error=None)
            self.reload(doc_id)
            return stats
        except Exception as error:
            self.manifest.update(doc_id, status="failed", error=str(error))
            raise

    # ── search ───────────────────────────────────────────────────────────────
    def search(
        self,
        query: str,
        device: dict | None = None,
        top_k: int = 6,
        doc_ids: list[str] | None = None,
        include_mismatch: bool = False,
    ) -> dict:
        query = (query or "").strip()
        if not query:
            return {"hits": [], "coverage": "insufficient", "reason": "empty query", "docs": []}
        with self._lock:
            candidates = list(self.indexes.values())
        if doc_ids:
            wanted = set(doc_ids)
            candidates = [index for index in candidates if index.doc_id in wanted]

        selected: list[tuple[DocIndex, dict, str, float, list[str]]] = []
        excluded: list[dict] = []
        for index in candidates:
            record = self.manifest.get(index.doc_id) or {}
            status, score, reasons = match_document(record, device)
            if status == "mismatch" and not include_mismatch:
                excluded.append({"docId": index.doc_id, "title": record.get("title"), "reasons": reasons})
                continue
            selected.append((index, record, status, score, reasons))
        selected.sort(key=lambda item: item[3], reverse=True)
        # When the device matches a manual exactly (vendor + model + version),
        # never mix in partial manuals: a newer/older edition can contain
        # different command syntax, and the user asked for manual-backed
        # accuracy. Partial documents are only a fallback with a warning.
        exact = [item for item in selected if item[2] == "exact"]
        fallback = None
        if exact:
            selected = exact
        elif device and selected:
            fallback = "no exact vendor/model/version manual match; results come from partial manuals"

        query_vector = None
        if self.embedder.enabled:
            encoded = self.embedder.encode([query], is_query=True)
            if encoded is not None and len(encoded):
                query_vector = encoded[0]

        fused: dict[str, float] = {}
        via: dict[str, set[str]] = {}
        matched_by_node: dict[str, list[str]] = {}
        dense_best = 0.0
        bm25_best = 0.0
        entity_best = 0.0
        weights = self.settings.weights
        rrf_k = self.settings.rrf_k

        def add(node_id: str, rank: int, weight: float, channel: str) -> None:
            fused[node_id] = fused.get(node_id, 0.0) + weight / (rrf_k + rank + 1)
            via.setdefault(node_id, set()).add(channel)

        for index, record, status, score, reasons in selected:
            dense = index.dense_search(query_vector, self.settings.dense_topk)
            if dense:
                dense_best = max(dense_best, dense[0][1])
            for rank, (node_id, _score) in enumerate(dense):
                add(node_id, rank, weights["dense"], "dense")
            bm25 = index.bm25_search(query, self.settings.bm25_topk)
            if bm25:
                bm25_best = max(bm25_best, bm25[0][1])
            for rank, (node_id, _score) in enumerate(bm25):
                add(node_id, rank, weights["bm25"], "bm25")
            tgm = index.tgm_search(query, self.settings.tgm_topk)
            if tgm:
                entity_best = max(entity_best, tgm[0]["score"])
            for rank, hit in enumerate(tgm):
                add(hit["id"], rank, weights["tgm"], "tgm")
                if hit["matched"]:
                    matched_by_node.setdefault(hit["id"], []).extend(hit["matched"])
            # keep per-document match metadata for the response
            record["_matchStatus"] = status
            record["_matchScore"] = score
            record["_matchReasons"] = reasons

        ranked_all = sorted(fused.items(), key=lambda item: item[1], reverse=True)
        reranker_enabled = self.reranker is not None and getattr(self.reranker, "enabled", False)
        candidate_limit = max(top_k, self.settings.rerank_topk) if reranker_enabled else top_k
        candidates: list[dict] = []
        for node_id, score in ranked_all[:candidate_limit]:
            doc_index = next((index for index, *_ in selected if index.node(node_id) is not None), None)
            if doc_index is None:
                continue
            node = doc_index.node(node_id)
            record = self.manifest.get(doc_index.doc_id) or {}
            candidates.append(
                {
                    "nodeId": node_id,
                    "docIndex": doc_index,
                    "node": node,
                    "record": record,
                    "fusedScore": score,
                    "section": " > ".join(node.get("section_path") or []),
                    "rerankScore": None,
                }
            )

        reranked = False
        if reranker_enabled and candidates:
            passages = [f"{item['section']}\n{item['node']['text']}" for item in candidates]
            scores = self.reranker.score(query, passages)
            if scores is not None and len(scores) == len(candidates):
                for item, score in zip(candidates, scores):
                    item["rerankScore"] = float(score)
                candidates.sort(key=lambda item: item["rerankScore"], reverse=True)
                reranked = True

        hits: list[dict] = []
        for item in candidates[:top_k]:
            doc_index = item["docIndex"]
            node = item["node"]
            record = item["record"]
            before = doc_index.node(node.get("prev")) if node.get("prev") else None
            after = doc_index.node(node.get("next")) if node.get("next") else None
            context_before = _trim(before["text"], 220) if before else ""
            context_after = _trim(after["text"], 220) if after else ""
            text = node["text"]
            if context_before or context_after:
                text = (context_before + "\n" if context_before else "") + text + ("\n" + context_after if context_after else "")
            hits.append(
                {
                    "nodeId": item["nodeId"],
                    "docId": doc_index.doc_id,
                    "title": record.get("title") or doc_index.meta.get("title"),
                    "vendor": record.get("vendor"),
                    "series": record.get("series") or [],
                    "versions": record.get("versions") or [],
                    "docType": record.get("docType"),
                    "section": item["section"],
                    "locator": _locator(node),
                    "text": text,
                    "textChars": len(text),
                    "score": round(item["rerankScore"], 5) if reranked else round(item["fusedScore"], 5),
                    "fusedScore": round(item["fusedScore"], 5),
                    "rerankScore": None if item["rerankScore"] is None else round(item["rerankScore"], 5),
                    "via": sorted(via.get(item["nodeId"], [])),
                    "matchedEntities": list(dict.fromkeys(matched_by_node.get(item["nodeId"], [])))[:6],
                    "match": {
                        "status": record.get("_matchStatus"),
                        "score": record.get("_matchScore"),
                        "reasons": record.get("_matchReasons"),
                    },
                }
            )

        coverage = "ok"
        reason = ""
        if not hits:
            coverage = "insufficient"
            reason = "no candidate documents" if not selected else "no lexical/entity/vector match"
        elif dense_best < 0.35 and bm25_best < 1.5 and entity_best <= 0:
            coverage = "insufficient"
            reason = "weak signals across dense, BM25 and entity channels"
        docs = [
            {
                "docId": index.doc_id,
                "title": record.get("title"),
                "match": status,
                "matchScore": score,
                "reasons": reasons,
            }
            for index, record, status, score, reasons in selected
        ]
        return {
            "hits": hits,
            "coverage": coverage,
            "reason": reason,
            "fallback": fallback,
            "docs": docs,
            "excluded": excluded,
            "signals": {
                "denseBest": round(dense_best, 4),
                "bm25Best": round(bm25_best, 4),
                "entityBest": round(entity_best, 4),
                "queryVector": query_vector is not None,
                "reranked": reranked,
            },
            "tookMs": 0,
        }

    def preview(self, doc_id: str, limit: int = 12) -> dict:
        with self._lock:
            index = self.indexes.get(doc_id)
            if index is None:
                record = self.manifest.get(doc_id)
                if record is None:
                    raise RuntimeError(f"unknown document: {doc_id}")
                index = DocIndex.load(self.settings.docs_dir / doc_id)
        nodes = index.nodes[: max(1, min(limit, 200))]
        return {
            "docId": doc_id,
            "title": self.manifest.get(doc_id, {}).get("title"),
            "nodes": [{"id": node["id"], "section": " > ".join(node.get("section_path") or []), "locator": _locator(node), "text": node["text"][:600]} for node in nodes],
            "stats": index.stats(),
        }