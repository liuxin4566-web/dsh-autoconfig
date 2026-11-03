# -*- coding: utf-8 -*-
"""Serializable BM25 index (k1=1.5, b=0.75)."""
from __future__ import annotations

import gzip
import json
import math
import os

from .tokenizer import tokenize


class BM25:
    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.doc_ids: list[str] = []
        self.doc_tokens: list[list[str]] = []
        self.doc_lens: list[int] = []
        self.avgdl = 0.0
        self.df: dict[str, int] = {}
        self.idf: dict[str, float] = {}
        self._tf: list[dict[str, int]] = []

    def add_docs(self, docs: list[dict], text_of=lambda doc: doc["text"]) -> None:
        self.doc_ids = [doc["id"] for doc in docs]
        self.doc_tokens = [tokenize(text_of(doc)) for doc in docs]
        self._finish()

    def _finish(self) -> None:
        self.doc_lens = [len(tokens) for tokens in self.doc_tokens]
        n = len(self.doc_tokens)
        self.avgdl = sum(self.doc_lens) / n if n else 0.0
        self.df = {}
        for tokens in self.doc_tokens:
            for token in set(tokens):
                self.df[token] = self.df.get(token, 0) + 1
        self.idf = {
            token: math.log(1 + (n - df + 0.5) / (df + 0.5))
            for token, df in self.df.items()
        }
        self._tf = []
        for tokens in self.doc_tokens:
            tf: dict[str, int] = {}
            for token in tokens:
                tf[token] = tf.get(token, 0) + 1
            self._tf.append(tf)

    def score(self, query_tokens: list[str], doc_index: int) -> float:
        length = self.doc_lens[doc_index]
        if length == 0:
            return 0.0
        tf = self._tf[doc_index]
        denominator = self.k1 * (1 - self.b + self.b * length / (self.avgdl or 1.0))
        total = 0.0
        for token in set(query_tokens):
            frequency = tf.get(token, 0)
            if not frequency:
                continue
            total += self.idf.get(token, 0.0) * frequency * (self.k1 + 1) / (frequency + denominator)
        return total

    def search(self, query: str, top_k: int = 30) -> list[tuple[str, float]]:
        query_tokens = tokenize(query)
        if not query_tokens or not self.doc_ids:
            return []
        scores = [self.score(query_tokens, index) for index in range(len(self.doc_ids))]
        ranked = sorted(range(len(scores)), key=lambda index: scores[index], reverse=True)[:top_k]
        return [(self.doc_ids[index], scores[index]) for index in ranked if scores[index] > 0]

    def to_payload(self) -> dict:
        return {
            "k1": self.k1,
            "b": self.b,
            "doc_ids": self.doc_ids,
            "doc_tokens": self.doc_tokens,
            "doc_lens": self.doc_lens,
            "avgdl": self.avgdl,
            "df": self.df,
            "idf": self.idf,
        }

    @classmethod
    def from_payload(cls, payload: dict) -> "BM25":
        index = cls(payload["k1"], payload["b"])
        index.doc_ids = payload["doc_ids"]
        index.doc_tokens = payload["doc_tokens"]
        index.doc_lens = payload["doc_lens"]
        index.avgdl = payload["avgdl"]
        index.df = payload["df"]
        index.idf = payload["idf"]
        index._tf = []
        for tokens in index.doc_tokens:
            tf: dict[str, int] = {}
            for token in tokens:
                tf[token] = tf.get(token, 0) + 1
            index._tf.append(tf)
        return index

    def save(self, path: str) -> None:
        tmp = path + ".tmp"
        with gzip.open(tmp, "wt", encoding="utf-8") as handle:
            json.dump(self.to_payload(), handle, ensure_ascii=False)
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: str) -> "BM25":
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return cls.from_payload(json.load(handle))