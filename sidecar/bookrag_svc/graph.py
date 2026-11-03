# -*- coding: utf-8 -*-
"""TGM's G (entity co-occurrence graph) and M (entity -> node mapping).

Deterministic and LLM-free: years, quoted terms, English identifiers and
Chinese noun phrases. The graph lets a query hop from a matched entity to
related entities, which recovers sections whose wording differs from the
question but shares the same subject matter.
"""
from __future__ import annotations

import re
import warnings
from collections import Counter, defaultdict

warnings.filterwarnings("ignore", category=SyntaxWarning)

try:
    from jieba import posseg
except ImportError:  # pragma: no cover
    posseg = None

from .tokenizer import tokenize

_YEAR_RE = re.compile(r"(?:19|20)\d{2}")
_QUOTED_RE = re.compile(r"[“\"]([^”\"]{2,30})[”\"]")
_EN_TERM_RE = re.compile(r"[A-Za-z][A-Za-z0-9_\-]{2,}")
_CJK_WORD_RE = re.compile(r"[\u4e00-\u9fff]{2,}")

_KEEP_POS = ("n", "nr", "ns", "nt", "nz", "vn")
_STOP_PREFIX = (
    "防止", "禁止", "避免", "确保", "保证", "使用", "配置", "进行",
    "支持", "提供", "需要", "可以", "不能", "以下", "上述", "用于",
    "包括", "采用", "开启", "关闭", "设置", "查看", "发送", "接收",
    "进入", "创建", "删除", "修改", "执行", "实现", "维护", "监控",
)


def _cn_entities(text: str, freq: Counter | None, strict: bool = True) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    if posseg is None:
        for match in _CJK_WORD_RE.finditer(text):
            word = match.group(0)
            if len(word) >= 3:
                found.add(("cn", word))
        return found
    for word, flag in posseg.cut(text):
        if not _CJK_WORD_RE.fullmatch(word):
            continue
        if flag not in _KEEP_POS:
            continue
        if word.startswith(_STOP_PREFIX):
            continue
        frequency = freq.get(word, 1) if freq is not None else 1
        if len(word) >= 3 and frequency >= 1:
            found.add(("cn", word))
        elif len(word) == 2 and (frequency >= 2 if strict else True):
            found.add(("cn", word))
    return found


def extract_entities(text: str, freq: Counter | None = None, strict: bool = True) -> list[tuple[str, str]]:
    entities: set[tuple[str, str]] = set()
    for match in _YEAR_RE.findall(text):
        entities.add(("year", match))
    for match in _QUOTED_RE.findall(text):
        entities.add(("term", match.strip()))
    for match in _EN_TERM_RE.findall(text):
        if len(match) >= 4 and not match.isdigit():
            entities.add(("term", match.lower()))
    entities |= _cn_entities(text, freq, strict=strict)
    return sorted(entities)


def _global_freq(nodes: list[dict]) -> Counter:
    counter: Counter = Counter()
    for node in nodes:
        for token in set(tokenize(node["text"])):
            counter[token] += 1
    return counter


def build_graph(nodes: list[dict]) -> dict:
    freq = _global_freq(nodes)
    node_entities: list[list[str]] = []
    entity_nodes: dict[str, set[str]] = defaultdict(set)

    for node in nodes:
        entities = [value for _, value in extract_entities(node["text"], freq)]
        node_entities.append(entities)
        for entity in entities:
            entity_nodes[entity].add(node["id"])

    entity_list = sorted(entity_nodes.keys(), key=lambda item: (len(entity_nodes[item]), item), reverse=True)
    edge_weight: dict[tuple[str, str], int] = defaultdict(int)
    for entities in node_entities:
        for left in range(len(entities)):
            for right in range(left + 1, len(entities)):
                pair = tuple(sorted((entities[left], entities[right])))
                if pair[0] != pair[1]:
                    edge_weight[pair] += 1
    edges = [[left, right, weight] for (left, right), weight in edge_weight.items()]
    return {
        "entities": entity_list,
        "edges": edges,
        "mapping": {entity: sorted(ids) for entity, ids in entity_nodes.items()},
    }