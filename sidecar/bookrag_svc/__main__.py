# -*- coding: utf-8 -*-
"""Entry point: ``python -m bookrag_svc --data-dir ... --token ...``."""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
from pathlib import Path

import uvicorn

from .config import Settings
from .embedder import Embedder
from .reranker import Reranker
from .search import Registry
from .server import create_app


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _resolve_model(settings: Settings, explicit: str | None) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    if settings.model_path:
        candidates.append(Path(settings.model_path).expanduser())
    candidates.append(settings.models_dir / "bge-m3")
    candidates.append(settings.models_dir / "bge-large-zh-v1.5")
    for candidate in candidates:
        if candidate.exists() and (candidate / "config.json").exists():
            return candidate
    return None


def _resolve_reranker(settings: Settings, explicit: str | None) -> Path | None:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    if settings.reranker_path:
        candidates.append(Path(settings.reranker_path).expanduser())
    candidates.append(settings.models_dir / "bge-reranker-v2-m3")
    candidates.append(settings.models_dir / "bge-reranker-base")
    for candidate in candidates:
        if candidate.exists() and (candidate / "config.json").exists():
            return candidate
    return None


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="bookrag_svc")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--config", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--reranker", default=None)
    parser.add_argument("--device", default=None, choices=["auto", "cuda", "cpu", "none"])
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", default=os.environ.get("BOOKRAG_SIDECAR_TOKEN", ""))
    parser.add_argument("--embedder", default=None, choices=["on", "off"])
    args = parser.parse_args(argv)

    settings = Settings.from_file(
        args.data_dir,
        path=args.config,
        port=args.port or None,
        token=args.token or None,
        device=args.device,
        model_path=args.model or None,
    )
    settings.ensure_dirs()

    use_embedder = args.embedder != "off" and settings.device != "none"
    model_path = _resolve_model(settings, args.model) if use_embedder else None
    embedder = Embedder(
        model_path,
        device=settings.device,
        batch_size=settings.batch_size,
        max_seq_length=settings.max_seq_length,
    )
    if use_embedder and model_path is None:
        # Lexical retrieval still works; the panel shows a setup hint.
        sys.stderr.write("[bookrag] embedding model not found; dense channel disabled\n")

    reranker_path = _resolve_reranker(settings, args.reranker) if use_embedder else None
    reranker = Reranker(reranker_path, device=settings.device)
    registry = Registry(settings, embedder, reranker)
    registry.load_all()
    app = create_app(settings, embedder, reranker, registry)

    port = settings.port or _free_port()
    ready = {
        "event": "ready",
        "port": port,
        "pid": os.getpid(),
        "version": "0.2.6",
        "dataDir": str(settings.data_dir),
        "model": embedder.status(),
        "reranker": reranker.status(),
        "docs": len(registry.indexes),
    }
    print(json.dumps(ready, ensure_ascii=False), flush=True)

    def warm_models() -> None:
        try:
            embedder.load()
            reranker.load()
        except Exception as error:  # a failed warmup must not kill the server
            sys.stderr.write(f"[bookrag] model warmup failed: {error}\n")

    threading.Thread(target=warm_models, name="bookrag-warmup", daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()