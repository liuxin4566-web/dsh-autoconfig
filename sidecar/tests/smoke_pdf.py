# -*- coding: utf-8 -*-
"""Ad-hoc smoke test against a real H3C PDF (not part of unittest discovery)."""
from pathlib import Path

from bookrag_svc.chunker import chunk_sections
from bookrag_svc.embedder import Embedder
from bookrag_svc.index_store import DocIndex, build_document
from bookrag_svc.parsers import parse_pdf

PDF = Path(r"E:\project\99-整本手册\99-H3C S5830V2[S5820V2]系列以太网交换机 典型配置举例.pdf")
OUT = Path(r"E:\dsh-autoconfig-data\kb\docs\smoke-h3c")

sections = parse_pdf(PDF)
print("pages:", len(sections), "chars:", sum(len(item["text"]) for item in sections))
nodes = chunk_sections(sections, max_chars=520)
print("nodes:", len(nodes), "avg chars:", sum(len(node["text"]) for node in nodes) // max(1, len(nodes)))
print("first paths:", [" > ".join(node["section_path"]) for node in nodes[:3]])

stats = build_document(
    doc_id="smoke-h3c",
    doc_record={"title": "H3C S5830V2/S5820V2 典型配置举例", "vendor": "h3c", "series": ["S5830V2", "S5820V2"], "versions": [{"raw": "7.1.075"}]},
    source_path=PDF,
    doc_dir=OUT,
    max_chars=520,
    embedder=Embedder(None, device="none"),
)
print("stats:", stats)
index = DocIndex.load(OUT)
for query in ["VLAN 接口 IP 地址", "配置 SSH 登录", "链路聚合"]:
    hits = index.bm25_search(query, top_k=3)
    print("\nQ:", query)
    for node_id, score in hits:
        node = index.node(node_id)
        print(f"  {score:.2f}  {' > '.join(node['section_path'])}  {node['text'][:60]!r}")
    tgm = index.tgm_search(query, top_k=2)
    for hit in tgm:
        node = index.node(hit["id"])
        print(f"  TGM {hit['score']:.1f} {hit['via']} {' > '.join(node['section_path'])}")