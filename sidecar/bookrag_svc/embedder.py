# -*- coding: utf-8 -*-
"""Local embedding model (bge-m3 / bge-large-zh / any SentenceTransformer)."""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np


class Embedder:
    def __init__(self, model_path: str | Path | None, device: str = "auto", batch_size: int = 16, max_seq_length: int = 512):
        self.model_path = str(model_path) if model_path else None
        self.device = device
        self.batch_size = batch_size
        self.max_seq_length = max_seq_length
        self._model = None
        self._lock = threading.Lock()
        self._actual_device: str | None = None
        self.error: str | None = None

    @property
    def enabled(self) -> bool:
        return self.device != "none" and bool(self.model_path)

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def dim(self) -> int | None:
        if self._model is None:
            return None
        try:
            return int(self._model.get_sentence_embedding_dimension())
        except Exception:
            return None

    def _resolve_device(self) -> str:
        if self.device in ("cpu", "cuda"):
            return self.device
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    def load(self) -> None:
        if self._model is not None or not self.enabled:
            return
        with self._lock:
            if self._model is not None:
                return
            from sentence_transformers import SentenceTransformer

            device = self._resolve_device()
            model = SentenceTransformer(self.model_path, device=device)
            model.max_seq_length = self.max_seq_length
            model.eval()
            self._model = model
            self._actual_device = device
            self.error = None

    def encode(self, texts: list[str], is_query: bool = False) -> np.ndarray | None:
        if not self.enabled:
            return None
        self.load()
        assert self._model is not None
        prefix = "为这个句子生成表示以用于检索相关文章：" if (is_query and "bge-large" in (self.model_path or "").lower()) else ""
        payload = [prefix + text for text in texts] if prefix else texts
        vectors = self._model.encode(
            payload,
            batch_size=self.batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        return np.asarray(vectors, dtype=np.float32)

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "loaded": self.loaded,
            "model": Path(self.model_path).name if self.model_path else None,
            "device": self._actual_device or self.device,
            "dim": self.dim,
            "error": self.error,
        }