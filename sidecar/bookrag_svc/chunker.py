# -*- coding: utf-8 -*-
"""Heading-aware chunking with code-fence protection and line numbers.

Input is either Markdown (`.md`/`.markdown`, or HTML converted to Markdown) or
pre-built page sections from the PDF parser. Output is a flat list of leaf
nodes; each leaf keeps the heading path for citations and TGM navigation.
"""
from __future__ import annotations

import re

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
ANCHOR_RE = re.compile(r"\s*\{#.*?\}\s*$")
XREF_RE = re.compile(r"\[([^\]]+)\]\(#[^)]*\)")
IMAGE_LINE_RE = re.compile(r"^!?\[!\[|^\s*\[!\s*\[|!\[\]\(")

NOISE_LINE_RES = [
    re.compile(r"^<\s*\[Home\]"),
    re.compile(r"^\[Home\]"),
    re.compile(r"^\[<\s*(上一节|上一页|返回目录)\]"),
    re.compile(r"^\[(上一节|上一页|返回目录)\]"),
    re.compile(r"^父主题[:：]"),
    re.compile(r"^版权所有"),
]


def _clean_title(title: str) -> str:
    return ANCHOR_RE.sub("", title).strip()


def _looks_like_heading(title: str) -> bool:
    """Reject page-caption text masquerading as a Markdown heading.

    Many PDF/Word manuals converted to Markdown emit a `#` line for a screenshot
    caption or a sentence ("密钥类，从DSA和RSA中任选一个…"). Treating those as
    headings creates huge bogus section paths.
    """
    if not title or title.startswith("!["):
        return False
    if len(title) > 48:
        return False
    if title.endswith("：") or title.endswith(":"):
        return False
    if ("，" in title or "。" in title) and len(title) > 24:
        return False
    return True


def parse_markdown_sections(text: str) -> list[dict]:
    """Split Markdown into heading-delimited sections, preserving line numbers."""
    lines = text.splitlines()
    sections: list[dict] = []
    stack: list[tuple[int, str]] = []
    current = {"path": [], "start": 1, "lines": [], "level": 0}
    in_code = False

    def flush(end_line: int) -> None:
        body = "\n".join(current["lines"]).strip()
        if body:
            sections.append(
                {
                    "path": list(current["path"]),
                    "text": body,
                    "start_line": current["start"],
                    "end_line": end_line,
                    "level": current["level"],
                    "page": None,
                }
            )

    for number, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if in_code:
            current["lines"].append(raw)
            if stripped.startswith("```"):
                in_code = False
            continue
        match = HEADING_RE.match(stripped)
        if match:
            level = len(match.group(1))
            title = _clean_title(match.group(2))
            if not _looks_like_heading(title):
                current["lines"].append(stripped)
                continue
            flush(number - 1)
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            current = {
                "path": [entry[1] for entry in stack],
                "start": number,
                "lines": [stripped],
                "level": level,
            }
            continue
        if stripped.startswith("```"):
            in_code = True
            current["lines"].append(raw)
            continue
        if not stripped:
            current["lines"].append("")
            continue
        if IMAGE_LINE_RE.search(stripped):
            continue
        if any(pattern.match(stripped) for pattern in NOISE_LINE_RES):
            continue
        current["lines"].append(XREF_RE.sub(r"\1", raw))
    flush(len(lines))
    return sections


def _split_lines(lines: list[tuple[int, str]], max_chars: int) -> list[dict]:
    """Pack numbered lines into pieces; never cut inside a fenced code block."""
    pieces: list[dict] = []
    buffer: list[tuple[int, str]] = []
    buffer_chars = 0
    in_code = False

    def emit() -> None:
        nonlocal buffer, buffer_chars
        text = "\n".join(line for _, line in buffer).strip()
        if text:
            pieces.append(
                {
                    "text": text,
                    "start_line": buffer[0][0],
                    "end_line": buffer[-1][0],
                }
            )
        buffer = []
        buffer_chars = 0

    for number, line in lines:
        stripped = line.strip()
        opening = not in_code and stripped.startswith("```")
        closing = in_code and stripped.startswith("```")
        length = len(line) + 1
        if buffer and buffer_chars + length > max_chars and not in_code and not closing:
            emit()
        buffer.append((number, line))
        buffer_chars += length
        if opening:
            in_code = True
        elif closing:
            in_code = False
    emit()
    return pieces


def chunk_sections(
    sections: list[dict],
    *,
    max_chars: int = 520,
    overlap: int = 80,
) -> list[dict]:
    """Flatten sections into leaf nodes; ``overlap`` is kept for API symmetry.

    Overlap is applied at retrieval time by expanding to neighbour leaves, so
    chunk text stays canonical and citations never point outside the excerpt.
    """
    nodes: list[dict] = []
    order = 0
    for section in sections:
        lines = section["text"].splitlines()
        base = section.get("start_line", 1)
        numbered = [(base + index, line) for index, line in enumerate(lines)]
        for piece in _split_lines(numbered, max_chars):
            if len(piece["text"]) < 20 and len(sections) > 1 and piece["start_line"] != base:
                continue
            order += 1
            nodes.append(
                {
                    "id": f"n{order:05d}",
                    "text": piece["text"],
                    "section_path": list(section["path"]),
                    "level": section.get("level", len(section["path"])),
                    "order": order,
                    "start_line": piece["start_line"],
                    "end_line": piece["end_line"],
                    "page": section.get("page"),
                }
            )
    for index, node in enumerate(nodes):
        node["prev"] = nodes[index - 1]["id"] if index > 0 else None
        node["next"] = nodes[index + 1]["id"] if index + 1 < len(nodes) else None
    return nodes


def chunk_markdown(text: str, *, max_chars: int = 520, overlap: int = 80) -> list[dict]:
    return chunk_sections(parse_markdown_sections(text), max_chars=max_chars, overlap=overlap)