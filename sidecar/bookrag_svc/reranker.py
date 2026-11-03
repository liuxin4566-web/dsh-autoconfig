# -*- coding: utf-8 -*-
"""Optional cross-encoder reranker (bge-reranker-v2-m3 or similar)."""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np


class Reranker:
    def __init__(self, model_path: str | Path | None, device: str = "auto", max_length: int = 512, batch_size: int = 8):
        self.model_path = str(model_path) if model_path else None
        self.device = device
        self.max_length = max_length
        self.batch_size = batch_size
        self._model = None
        self._lock = threading.Lock()
        self._actual_device: str | None = None
        self.error: str | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.model_path)

    @property
    def loaded(self) -> bool:
        return self._model is not None

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
            from sentence_transformers import CrossEncoder

            device = self._resolve_device()
            self._model = CrossEncoder(self.model_path, max_length=self.max_length, device=device)
            self._actual_device = device
            self.error = None

    def score(self, query: str, passages: list[str]) -> np.ndarray | None:
        if not self.enabled or not passages:
            return None
        self.load()
        assert self._model is not None
        pairs = [[query, passage] for passage in passages]
        scores = self._model.predict(pairs, batch_size=self.batch_size, show_progress_bar=False)
        return np.asarray(scores, dtype=np.float32)

    def status(self) -> dict:
        return {
            "enabled": self.enabled,
            "loaded": self.loaded,
            "model": Path(self.model_path).name if self.model_path else None,
            "device": self._actual_device or self.device,
            "error": self.error,
        }