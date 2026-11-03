# -*- coding: utf-8 -*-
import json
import tempfile
import unittest
from pathlib import Path

from bookrag_svc.bm25 import BM25
from bookrag_svc.chunker import chunk_markdown
from bookrag_svc.embedder import Embedder
from bookrag_svc.graph import build_graph
from bookrag_svc.index_store import DocIndex, build_document
from bookrag_svc.manifest import normalize_version, version_matches

SAMPLE = """# S5820V2 配置手册

## 以太网接口

### 配置接口描述
进入接口视图并设置描述。

```
system-view
interface GigabitEthernet 1/0/1
description uplink-to-core
```

### 配置接口速率
使用 speed 命令设置速率。

## VLAN

### 创建 VLAN
执行 vlan 10 创建 VLAN 10，然后进入 VLAN 视图。

```
system-view
vlan 10
quit
```

### 配置 VLAN 接口 IP
为 VLAN 接口配置 IP 地址。

```
interface Vlan-interface 10
ip address 192.168.10.1 255.255.255.0
```
"""


class ChunkerTest(unittest.TestCase):
    def test_heading_path_and_code_block(self):
        nodes = chunk_markdown(SAMPLE, max_chars=200, overlap=0)
        self.assertGreaterEqual(len(nodes), 3)
        paths = [" > ".join(node["section_path"]) for node in nodes]
        self.assertTrue(any("VLAN" in path for path in paths))
        joined = "\n".join(node["text"] for node in nodes)
        self.assertIn("system-view", joined)
        self.assertIn("ip address 192.168.10.1", joined)
        # A fenced block must never be split across two leaves.
        for node in nodes:
            self.assertEqual(node["text"].count("```") % 2, 0)

    def test_line_numbers(self):
        nodes = chunk_markdown(SAMPLE, max_chars=200, overlap=0)
        self.assertTrue(all(node["start_line"] >= 1 for node in nodes))
        self.assertTrue(all(node["end_line"] >= node["start_line"] for node in nodes))


class BM25Test(unittest.TestCase):
    def test_ranks_vlan_section(self):
        nodes = chunk_markdown(SAMPLE, max_chars=200, overlap=0)
        index = BM25()
        index.add_docs(nodes)
        hits = index.search("创建 VLAN 10", top_k=3)
        self.assertTrue(hits)
        best = next(node for node in nodes if node["id"] == hits[0][0])
        self.assertIn("VLAN", " > ".join(best["section_path"]))


class GraphTest(unittest.TestCase):
    def test_entities_and_mapping(self):
        nodes = chunk_markdown(SAMPLE, max_chars=200, overlap=0)
        graph = build_graph(nodes)
        self.assertTrue(graph["entities"])
        self.assertTrue(graph["mapping"])
        for node_id in graph["mapping"].values():
            self.assertTrue(node_id)


class VersionTest(unittest.TestCase):
    def test_version_prefix_and_range(self):
        self.assertTrue(version_matches("V9.5.0.2", {"raw": "V9.5.0.2"}))
        self.assertTrue(version_matches("7.1.075", {"min": "7.1.0", "max": "7.1.99"}))
        self.assertFalse(version_matches("7.1.075", {"raw": "9.5.0.2"}))
        self.assertEqual(normalize_version("v9.7.40.8(R)"), "9.7.40.8")


class BuildSearchTest(unittest.TestCase):
    def test_build_and_search_without_embedder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc_dir = root / "doc"
            doc_dir.mkdir()
            source = doc_dir / "source.md"
            source.write_text(SAMPLE, encoding="utf-8")
            stats = build_document(
                doc_id="doc",
                doc_record={"title": "S5820V2 配置手册"},
                source_path=source,
                doc_dir=doc_dir,
                max_chars=200,
                embedder=Embedder(None, device="none"),
            )
            self.assertGreater(stats["nodes"], 0)
            index = DocIndex.load(doc_dir)
            hits = index.bm25_search("VLAN 接口 IP", top_k=3)
            self.assertTrue(hits)
            tgm = index.tgm_search("VLAN 接口 IP", top_k=3)
            self.assertTrue(tgm)
            dense = index.dense_search(None, top_k=3)
            self.assertEqual(dense, [])


if __name__ == "__main__":
    unittest.main()