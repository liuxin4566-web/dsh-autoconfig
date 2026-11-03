# -*- coding: utf-8 -*-
"""Chinese/English tokenizer shared by BM25 and entity extraction."""
from __future__ import annotations

import re
import warnings

try:  # jieba is the only optional import in the retrieval core
    warnings.filterwarnings("ignore", category=SyntaxWarning)
    import jieba

    jieba.setLogLevel(60)
    _HAS_JIEBA = True
except ImportError:  # pragma: no cover - fallback keeps the service importable
    _HAS_JIEBA = False

_TOKEN_RE = re.compile(r"[A-Za-z]+(?:[A-Za-z0-9_\-]*)|[0-9]+(?:\.[0-9]+)?|[\u4e00-\u9fff]+")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def tokenize(text: str) -> list[str]:
    """Lower-cased token list: jieba for Chinese, word/number split otherwise."""
    text = (text or "").lower()
    if not text.strip():
        return []
    words: list[str] = []
    if _HAS_JIEBA:
        for segment in jieba.cut(text):
            segment = segment.strip()
            if not segment:
                continue
            if _CJK_RE.fullmatch(segment):
                words.append(segment)
            else:
                words.extend(_TOKEN_RE.findall(segment))
        return [word for word in words if word]
    for piece in _TOKEN_RE.findall(text):
        if re.fullmatch(r"[A-Za-z0-9.\-]+", piece):
            words.append(piece)
        elif len(piece) == 1:
            words.append(piece)
        else:
            words.extend(piece[i : i + 2] for i in range(len(piece) - 1))
    return words