# -*- coding: utf-8 -*-
"""Runtime configuration for the BookRAG sidecar."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Settings:
    data_dir: Path
    model_path: Path | None = None
    reranker_path: Path | None = None
    model_name: str = "BAAI/bge-m3"
    rerank_topk: int = 20
    device: str = "auto"          # auto | cuda | cpu | none
    batch_size: int = 16
    max_seq_length: int = 512
    chunk_max_chars: int = 520
    chunk_overlap: int = 80
    dense_topk: int = 30
    bm25_topk: int = 30
    tgm_topk: int = 30
    rrf_k: int = 60
    weights: dict = field(default_factory=lambda: {"dense": 1.0, "bm25": 1.0, "tgm": 1.2})
    host: str = "127.0.0.1"
    port: int = 0
    token: str = ""

    @property
    def kb_dir(self) -> Path:
        return self.data_dir / "kb"

    @property
    def docs_dir(self) -> Path:
        return self.kb_dir / "docs"

    @property
    def manifest_path(self) -> Path:
        return self.kb_dir / "manifest.json"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def log_dir(self) -> Path:
        return self.data_dir / "logs"

    def ensure_dirs(self) -> None:
        for path in (self.kb_dir, self.docs_dir, self.models_dir, self.log_dir):
            path.mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_file(cls, data_dir: str | Path, path: str | Path | None = None, **overrides) -> "Settings":
        values: dict = {"data_dir": Path(data_dir).expanduser().resolve()}
        if path is not None and Path(path).exists():
            raw = json.loads(Path(path).read_text(encoding="utf-8"))
            if raw.get("model_path"):
                raw["model_path"] = Path(raw["model_path"]).expanduser()
            if raw.get("reranker_path"):
                raw["reranker_path"] = Path(raw["reranker_path"]).expanduser()
            values.update(raw)
        values.update({key: value for key, value in overrides.items() if value is not None})
        return cls(**values)