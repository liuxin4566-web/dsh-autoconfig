# -*- coding: utf-8 -*-
"""Document registry (manifest.json) and device/manual matching helpers."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

_LOCK = threading.RLock()


def normalize_version(value: str | None) -> str:
    text = (value or "").strip().upper()
    if text.startswith("V"):
        text = text[1:]
    text = re.sub(r"\(R\)", "", text)
    text = re.sub(r"[^0-9A-Z.]", ".", text)
    return text.strip(".")


def _version_tuple(value: str) -> tuple[int, ...]:
    numbers = [int(part) for part in re.findall(r"\d+", value)]
    return tuple(numbers)


def version_matches(device_version: str | None, entry: dict | str | None) -> bool:
    if not device_version or not entry:
        return False
    device = normalize_version(device_version)
    if isinstance(entry, str):
        wanted = normalize_version(entry)
        return bool(wanted) and (device == wanted or device.startswith(wanted + ".") or wanted.startswith(device + "."))
    raw = normalize_version(entry.get("raw"))
    if raw and (device == raw or device.startswith(raw + ".") or raw.startswith(device + ".")):
        return True
    minimum = entry.get("min")
    maximum = entry.get("max")
    if minimum or maximum:
        current = _version_tuple(device)
        if minimum and current < _version_tuple(str(minimum)):
            return False
        if maximum and current > _version_tuple(str(maximum)):
            return False
        return bool(current)
    return False


def match_document(doc: dict, device: dict | None) -> tuple[str, float, list[str]]:
    """Return (status, score, reasons) for one document against a device."""
    if not device:
        return "unknown", 0.0, []
    vendor = (device.get("vendor") or "").lower()
    doc_vendor = (doc.get("vendor") or "").lower()
    model = (device.get("model") or "").lower()
    version = device.get("version")
    reasons: list[str] = []
    score = 0.0

    if vendor and doc_vendor and vendor != doc_vendor:
        return "mismatch", -10.0, [f"vendor {doc_vendor} != device {vendor}"]

    if vendor and doc_vendor and vendor == doc_vendor:
        score += 1.0
        reasons.append("vendor")
    elif not doc_vendor:
        reasons.append("doc vendor unknown")

    series = [str(item).lower() for item in (doc.get("series") or [])] + [str(item).lower() for item in (doc.get("models") or [])]
    if model and series:
        if any(item and (item in model or model in item) for item in series):
            score += 2.0
            reasons.append("model")
        else:
            reasons.append("model differs")
    elif model:
        reasons.append("doc model unknown")

    versions = doc.get("versions") or []
    if version and versions:
        if any(version_matches(version, entry) for entry in versions):
            score += 2.0
            reasons.append("version")
        else:
            reasons.append("version differs")
    elif version:
        reasons.append("doc version unknown")

    if "model differs" in reasons or "version differs" in reasons:
        return "partial", score, reasons
    if score >= 3.0:
        return "exact", score, reasons
    return "partial", score, reasons


class Manifest:
    def __init__(self, path: Path):
        self.path = path
        self.docs: dict[str, dict] = {}
        self.load()

    def load(self) -> None:
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                self.docs = raw.get("docs", {}) if isinstance(raw, dict) else {}
            except Exception:
                self.docs = {}

    def save(self) -> None:
        payload = {"version": 1, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "docs": self.docs}
        tmp = str(self.path) + ".tmp"
        with _LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)

    def add(self, record: dict) -> None:
        with _LOCK:
            self.docs[record["docId"]] = record
            self.save()

    def update(self, doc_id: str, **fields) -> dict | None:
        with _LOCK:
            record = self.docs.get(doc_id)
            if record is None:
                return None
            record.update(fields)
            record["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            self.save()
            return record

    def get(self, doc_id: str) -> dict | None:
        return self.docs.get(doc_id)

    def delete(self, doc_id: str) -> dict | None:
        with _LOCK:
            record = self.docs.pop(doc_id, None)
            self.save()
            return record

    def list(self) -> list[dict]:
        return sorted(self.docs.values(), key=lambda item: item.get("createdAt", ""), reverse=True)