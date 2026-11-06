# -*- coding: utf-8 -*-
"""BookRAG sidecar HTTP API (localhost only, bearer-token protected)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import Settings
from .embedder import Embedder
from .manifest import Manifest
from .search import Registry

VERSION = "1.0.0"


class TaskManager:
    def __init__(self):
        self.tasks: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bookrag-build")

    def submit(self, kind: str, title: str, fn) -> str:
        task_id = uuid.uuid4().hex[:12]
        task = {
            "id": task_id,
            "kind": kind,
            "title": title,
            "status": "queued",
            "progress": 0.0,
            "message": "排队中",
            "log": [],
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "startedAt": None,
            "finishedAt": None,
            "error": None,
        }
        with self._lock:
            self.tasks[task_id] = task

        def progress(message: str, fraction: float) -> None:
            with self._lock:
                task["message"] = message
                task["progress"] = round(float(fraction), 3)
                task["log"].append(message)
                if len(task["log"]) > 400:
                    task["log"] = task["log"][-400:]

        def run() -> None:
            with self._lock:
                task["status"] = "running"
                task["startedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            try:
                result = fn(progress)
                with self._lock:
                    task["status"] = "done"
                    task["progress"] = 1.0
                    task["message"] = "完成"
                    task["result"] = result
            except Exception as error:  # surface the failure to the panel
                with self._lock:
                    task["status"] = "failed"
                    task["error"] = str(error)
                    task["message"] = str(error)
                    task["log"].append(f"ERROR: {error}")
            finally:
                with self._lock:
                    task["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")

        self._pool.submit(run)
        return task_id

    def get(self, task_id: str) -> dict | None:
        with self._lock:
            task = self.tasks.get(task_id)
            return dict(task) if task else None


class SearchRequest(BaseModel):
    query: str
    device: dict | None = None
    topK: int = 6
    docIds: list[str] | None = None
    includeMismatch: bool = False


def _slug(text: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", text or "").strip("-")
    return cleaned[:48] or "doc"


def _split_list(value) -> list[str]:
    if not value:
        return []
    if isinstance(value, (list, tuple)):
        return [str(item).strip() for item in value if str(item).strip()]
    if value.strip().startswith("["):
        try:
            data = json.loads(value)
            return [str(item).strip() for item in data if str(item).strip()]
        except Exception:
            pass
    return [part.strip() for part in re.split(r"[,，;；]", value) if part.strip()]


def _parse_versions(value) -> list[dict]:
    if not value:
        return []
    if isinstance(value, list):
        result = []
        for item in value:
            if isinstance(item, str):
                result.append({"raw": item})
            elif isinstance(item, dict):
                result.append(item)
        return result
    try:
        data = json.loads(value)
        if isinstance(data, list):
            result = []
            for item in data:
                if isinstance(item, str):
                    result.append({"raw": item})
                elif isinstance(item, dict):
                    result.append(item)
            return result
    except Exception:
        pass
    result = []
    for part in re.split(r"[,，;；]", value):
        part = part.strip()
        if not part:
            continue
        match = re.fullmatch(r"([0-9][0-9.]*)\s*[-~]\s*([0-9][0-9.]*)", part)
        if match:
            result.append({"min": match.group(1), "max": match.group(2)})
        else:
            result.append({"raw": part})
    return result


def create_app(settings: Settings, embedder: Embedder, reranker, registry: Registry) -> FastAPI:
    app = FastAPI(title="BookRAG sidecar", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    tasks = TaskManager()
    app.state.tasks = tasks
    build_lock = threading.Lock()
    build_tasks: dict[str, str] = {}
    app.state.registry = registry
    app.state.embedder = embedder

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def authorize(authorization: str | None = Header(default=None), x_bookrag_token: str | None = Header(default=None)) -> None:
        expected = settings.token or ""
        if not expected:
            return
        supplied = ""
        if authorization and authorization.lower().startswith("bearer "):
            supplied = authorization[7:].strip()
        elif x_bookrag_token:
            supplied = x_bookrag_token
        if not supplied or not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="invalid token")

    @app.get("/health")
    def health(_: None = Depends(authorize)) -> dict:
        return {
            "ok": True,
            "version": VERSION,
            "pid": os.getpid(),
            "dataDir": str(settings.data_dir),
            "model": embedder.status(),
            "reranker": reranker.status() if reranker is not None else None,
            "docs": len(registry.manifest.docs),
            "indexes": list(registry.indexes.keys()),
            "loadErrors": registry._load_errors,
        }

    @app.get("/docs")
    def list_docs(_: None = Depends(authorize)) -> dict:
        return {"docs": registry.manifest.list()}

    @app.post("/docs")
    async def upload_doc(
        file: UploadFile = File(...),
        metadata: str = Form("{}"),
        build: bool = Form(False),
        _: None = Depends(authorize),
    ) -> dict:
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in (".md", ".markdown", ".pdf", ".chm", ".txt"):
            raise HTTPException(status_code=400, detail=f"unsupported file type: {suffix}")
        try:
            meta = json.loads(metadata or "{}")
        except Exception:
            raise HTTPException(status_code=400, detail="metadata must be JSON")
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="empty upload")
        digest = hashlib.sha256(data).hexdigest()[:16]
        title = (meta.get("title") or Path(file.filename).stem).strip()
        doc_id = f"{_slug(meta.get('docId') or title)}-{digest[:6]}"
        doc_dir = settings.docs_dir / doc_id
        doc_dir.mkdir(parents=True, exist_ok=True)
        stored = f"source{suffix}"
        (doc_dir / stored).write_bytes(data)
        record = {
            "docId": doc_id,
            "title": title,
            "vendor": (meta.get("vendor") or "").strip(),
            "series": _split_list(meta.get("series")),
            "models": _split_list(meta.get("models")),
            "versions": _parse_versions(meta.get("versions")),
            "docType": (meta.get("docType") or "").strip(),
            "notes": (meta.get("notes") or "").strip(),
            "sourceFile": file.filename,
            "storedFile": stored,
            "sourceHash": digest,
            "size": len(data),
            "status": "uploaded",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "stats": None,
            "error": None,
        }
        registry.manifest.add(record)
        task_id = None
        if build:
            task_id = tasks.submit("build", f"构建 {title}", lambda progress: registry.build(doc_id, progress))
        return {"ok": True, "doc": record, "taskId": task_id}

    @app.post("/docs/{doc_id}/build")
    def build_doc(doc_id: str, _: None = Depends(authorize)) -> dict:
        if registry.manifest.get(doc_id) is None:
            raise HTTPException(status_code=404, detail="document not found")
        with build_lock:
            existing = build_tasks.get(doc_id)
            if existing:
                current = tasks.get(existing)
                if current and current.get("status") in ("queued", "running"):
                    return {"ok": True, "taskId": existing, "reused": True}
            task_id = tasks.submit("build", f"构建 {doc_id}", lambda progress: registry.build(doc_id, progress))
            build_tasks[doc_id] = task_id
        return {"ok": True, "taskId": task_id}

    @app.get("/tasks/{task_id}")
    def task_status(task_id: str, _: None = Depends(authorize)) -> dict:
        task = tasks.get(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        return task

    @app.get("/docs/{doc_id}/preview")
    def preview_doc(doc_id: str, limit: int = 12, _: None = Depends(authorize)) -> dict:
        try:
            return registry.preview(doc_id, limit=limit)
        except Exception as error:
            raise HTTPException(status_code=404, detail=str(error))

    @app.delete("/docs/{doc_id}")
    def delete_doc(doc_id: str, _: None = Depends(authorize)) -> dict:
        record = registry.manifest.delete(doc_id)
        registry.drop(doc_id)
        doc_dir = settings.docs_dir / doc_id
        if doc_dir.exists():
            shutil.rmtree(doc_dir, ignore_errors=True)
        return {"ok": True, "removed": record is not None}

    @app.post("/search")
    def search(request: SearchRequest, _: None = Depends(authorize)) -> dict:
        started = time.perf_counter()
        result = registry.search(
            request.query,
            device=request.device,
            top_k=max(1, min(int(request.topK or 6), 20)),
            doc_ids=request.docIds,
            include_mismatch=request.includeMismatch,
        )
        result["tookMs"] = round((time.perf_counter() - started) * 1000, 1)
        return result

    @app.get("/stats")
    def stats(_: None = Depends(authorize)) -> dict:
        return {
            "docs": registry.manifest.list(),
            "indexes": {doc_id: index.stats() for doc_id, index in registry.indexes.items()},
            "model": embedder.status(),
            "reranker": reranker.status() if reranker is not None else None,
        }

    @app.post("/shutdown")
    def shutdown(_: None = Depends(authorize)) -> dict:
        threading.Timer(0.3, lambda: os._exit(0)).start()
        return {"ok": True}

    return app