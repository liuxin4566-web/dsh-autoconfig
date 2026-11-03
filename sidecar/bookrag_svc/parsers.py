# -*- coding: utf-8 -*-
"""Source parsers: Markdown, text-selectable PDF, and Windows CHM.

Every parser returns heading-aware sections (page numbers preserved for PDFs)
so the chunker, TGM and citations share one representation.
"""
from __future__ import annotations

import html
import re
import shutil
import subprocess
import sys
from pathlib import Path

from .chunker import parse_markdown_sections

PDF_LINE_SCALE = 10000
_TOC_DOTS_RE = re.compile(r"[.·]{4,}")
_PAGE_NOISE_RE = re.compile(r"^(?:Copyright|版权所有|非经本公司|并不得以任何形式|本文档中的信息|第\s*\d+\s*页\s*$)", re.IGNORECASE)


def _clean_pdf_text(text: str) -> str:
    text = text.replace("\r", "")
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _pdf_bookmarks(pdf) -> list[tuple[int, str, int]]:
    """Return [(level, title, page_index)] from the PDF outline."""
    result: list[tuple[int, str, int]] = []
    try:
        bookmarks = list(pdf.get_toc())
    except Exception:
        return result
    for bookmark in bookmarks:
        try:
            title = str(bookmark.get_title()).strip()
            level = int(bookmark.level)
            page_index = int(bookmark.get_dest().get_index())
        except Exception:
            continue
        if title:
            result.append((level, title, page_index))
    return result


def _active_paths(total_pages: int, bookmarks: list[tuple[int, str, int]]) -> list[list[str]]:
    """Map each page index to the bookmark stack active on that page."""
    paths: list[list[str]] = [[] for _ in range(total_pages)]
    stack: list[tuple[int, str]] = []
    cursor = 0
    for page in range(total_pages):
        while cursor < len(bookmarks) and bookmarks[cursor][2] <= page:
            level, title, _ = bookmarks[cursor]
            cursor += 1
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
        paths[page] = [title for level, title in stack if level <= 1][-2:]
    return paths


def _clean_page_text(text: str) -> str:
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            lines.append("")
            continue
        if _TOC_DOTS_RE.search(stripped):
            continue
        if _PAGE_NOISE_RE.match(stripped):
            continue
        if re.fullmatch(r"[ivxlcdm]{1,6}|\d{1,4}", stripped, re.IGNORECASE):
            # Page number or roman numeral in the running header.
            continue
        lines.append(line)
    text = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


_HEADING_NUM_RE = re.compile(r"^\s*(\d+(?:\.\d+){1,3})\s+(\S.{0,70})$")


def _pdf_heading(line: str) -> str | None:
    match = _HEADING_NUM_RE.match(line)
    if not match:
        return None
    text = match.group(2).strip()
    if not text or re.fullmatch(r"[\d.\s]+", text):
        return None
    if "255.255" in text:
        return None
    if not re.search(r"[\u4e00-\u9fffA-Za-z]", text):
        return None
    if len(line.strip()) > 90:
        return None
    return f"{match.group(1)} {text}"


def _page_sections(text: str, base_path: list[str], page: int) -> list[dict]:
    """Split one PDF page at numbered subheadings (4.2, 5.4.2, ...)."""
    lines = text.splitlines()
    raw_segments: list[dict] = []
    buffer: list[str] = []
    heading: str | None = None
    start = 1

    def flush(end_line: int) -> None:
        nonlocal buffer, heading, start
        body = "\n".join(buffer).strip()
        if body:
            raw_segments.append({"heading": heading, "start": start, "end": end_line, "text": body})
        buffer = []
        heading = None

    for number, line in enumerate(lines, 1):
        detected = _pdf_heading(line)
        if detected is not None:
            flush(number - 1)
            heading = detected
            start = number
            buffer = [line]
            continue
        buffer.append(line)
    flush(len(lines))

    sections: list[dict] = []
    for segment in raw_segments:
        path = list(base_path)
        if segment["heading"]:
            path.append(segment["heading"])
        sections.append(
            {
                "path": path[-5:],
                "text": segment["text"],
                "start_line": page * PDF_LINE_SCALE + segment["start"],
                "end_line": page * PDF_LINE_SCALE + segment["end"],
                "level": max(1, len(path)),
                "page": page,
            }
        )
    # Fold tiny fragments into the previous section so the index has no
    # one-line leaves that only match stopwords.
    merged: list[dict] = []
    for section in sections:
        if merged and len(section["text"]) < 40:
            merged[-1]["text"] += "\n" + section["text"]
            merged[-1]["end_line"] = section["end_line"]
        else:
            merged.append(section)
    return merged


def parse_pdf(path: Path) -> list[dict]:
    try:
        import pypdfium2 as pdfium
    except ImportError as error:  # pragma: no cover
        raise RuntimeError("pypdfium2 is required to parse PDF files") from error

    document = pdfium.PdfDocument(str(path))
    sections: list[dict] = []
    try:
        total = len(document)
        bookmarks = _pdf_bookmarks(document)
        paths = _active_paths(total, bookmarks)
        for page_index in range(total):
            page_number = page_index + 1
            try:
                raw = document[page_index].get_textpage().get_text_range()
            except Exception:
                continue
            raw_lines = [line for line in raw.splitlines() if line.strip()]
            dot_lines = sum(1 for line in raw_lines if _TOC_DOTS_RE.search(line))
            if raw_lines and dot_lines / len(raw_lines) > 0.3:
                # Table-of-contents pages only add noise to BM25 and embeddings.
                continue
            text = _clean_page_text(_clean_pdf_text(raw))
            if len(text) < 20:
                continue
            breadcrumb = list(paths[page_index]) if page_index < len(paths) else []
            sections.extend(_page_sections(text, breadcrumb, page_number))
    finally:
        try:
            document.close()
        except Exception:
            pass
    if not sections:
        raise RuntimeError("PDF has no selectable text (scanned PDFs are not supported)")
    return sections


def _find_7z() -> str | None:
    found = shutil.which("7z") or shutil.which("7za")
    if found:
        return found
    candidates = [
        Path(r"C:\Program Files\7-Zip\7z.exe"),
        Path(r"C:\Program Files (x86)\7-Zip\7z.exe"),
        Path(r"C:\Program Files\7-Zip\7za.exe"),
    ]
    return str(next((path for path in candidates if path.exists()), "")) or None


def _decompile_chm(chm: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    if sys.platform == "win32":
        hh = shutil.which("hh") or r"C:\Windows\hh.exe"
        try:
            subprocess.run([hh, "-decompile", str(out_dir), str(chm)], check=False, timeout=180, capture_output=True)
        except Exception as error:
            errors.append(f"hh.exe: {error}")
    if not any(out_dir.rglob("*.htm*")):
        seven = _find_7z()
        if seven:
            try:
                subprocess.run([seven, "x", "-y", f"-o{out_dir}", str(chm)], check=False, timeout=180, capture_output=True)
            except Exception as error:
                errors.append(f"7z: {error}")
    if not any(out_dir.rglob("*.htm*")):
        raise RuntimeError("CHM decompile produced no HTML files" + (f" ({'; '.join(errors)})" if errors else ""))


def _read_html(path: Path) -> str:
    data = path.read_bytes()
    match = re.search(rb"charset\s*=\s*[\"']?([A-Za-z0-9_\-]+)", data[:4096], re.IGNORECASE)
    encodings = []
    if match:
        encodings.append(match.group(1).decode("ascii", "ignore"))
    encodings.extend(["utf-8", "gb18030", "big5"])
    for encoding in encodings:
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", "ignore")


_HHC_NAME_RE = re.compile(r'name\s*=\s*"Name"\s+value\s*=\s*"([^"]*)"', re.IGNORECASE)
_HHC_LOCAL_RE = re.compile(r'name\s*=\s*"Local"\s+value\s*=\s*"([^"]*)"', re.IGNORECASE)


def _parse_hhc(path: Path) -> tuple[list[str], dict[str, list[str]]]:
    """Return TOC order and {relative_html: section path} from a .hhc file."""
    text = _read_html(path)
    order: list[str] = []
    mapping: dict[str, list[str]] = {}
    try:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(text, "html.parser")
        for item in soup.find_all("li"):
            name = ""
            local = ""
            for param in item.find_all("param"):
                key = (param.get("name") or "").lower()
                if key == "name":
                    name = param.get("value") or ""
                elif key == "local":
                    local = param.get("value") or ""
            if not local:
                continue
            depth = len(item.find_parents("ul"))
            path_list = list(mapping.get(local, []))
            mapping[local] = path_list[: max(0, depth - 1)] + [name or local]
            order.append(local)
    except ImportError:
        for block in re.findall(r"<li[^>]*>(.*?)</li>", text, re.IGNORECASE | re.DOTALL):
            name_match = _HHC_NAME_RE.search(block)
            local_match = _HHC_LOCAL_RE.search(block)
            if not local_match:
                continue
            local = local_match.group(1)
            mapping[local] = [name_match.group(1)] if name_match else [local]
            order.append(local)
    return order, mapping


def _html_to_markdown(text: str) -> str:
    try:
        from markdownify import markdownify

        converted = markdownify(text, heading_style="ATX", bullets="-")
    except ImportError:
        converted = re.sub(r"<[^>]+>", " ", text)
        converted = html.unescape(converted)
    converted = re.sub(r"\n{3,}", "\n\n", converted)
    converted = re.sub(r"[ \t]+\n", "\n", converted)
    return converted.strip()


def parse_chm(path: Path, workdir: Path) -> str:
    out_dir = workdir / "chm"
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)
    _decompile_chm(path, out_dir)
    hhc = next(iter(sorted(out_dir.rglob("*.hhc"))), None)
    order: list[str] = []
    mapping: dict[str, list[str]] = {}
    if hhc is not None:
        order, mapping = _parse_hhc(hhc)
    html_files = sorted(out_dir.rglob("*.htm*"), key=lambda item: item.as_posix().lower())
    by_name = {item.name.lower(): item for item in html_files}
    ordered: list[Path] = []
    for local in order:
        key = Path(local.replace("\\", "/")).name.lower()
        target = by_name.get(key)
        if target is not None and target not in ordered:
            ordered.append(target)
    for item in html_files:
        if item not in ordered:
            ordered.append(item)

    parts: list[str] = []
    for item in ordered:
        markdown = _html_to_markdown(_read_html(item))
        if len(markdown.strip()) < 30:
            continue
        title_path = mapping.get(item.name) or mapping.get(item.name.lower()) or []
        prefix = ""
        if title_path and not re.search(r"^#{1,6}\s", markdown, re.MULTILINE):
            depth = min(3, max(1, len(title_path)))
            prefix = "#" * depth + " " + title_path[-1] + "\n\n"
        parts.append(prefix + markdown)
    if not parts:
        raise RuntimeError("CHM contained no readable HTML content")
    return "\n\n".join(parts)


def parse_source(path: Path, workdir: Path) -> tuple[str, str]:
    """Return (markdown_text, kind) for a source file."""
    suffix = path.suffix.lower()
    if suffix in (".md", ".markdown", ".txt"):
        return path.read_text(encoding="utf-8", errors="ignore"), "markdown"
    if suffix == ".pdf":
        sections = parse_pdf(path)
        return "\n\n".join(section["text"] for section in sections), "pdf"
    if suffix == ".chm":
        return parse_chm(path, workdir), "chm"
    raise RuntimeError(f"unsupported source type: {suffix}")


def sections_for(path: Path, workdir: Path) -> list[dict]:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return parse_pdf(path)
    markdown, _ = parse_source(path, workdir)
    return parse_markdown_sections(markdown)