# bookrag_svc — local manual retrieval sidecar

This directory is the Python half of `dsh-autoconfig` 0.2.0. It is started by the
plugin host on demand and binds `127.0.0.1` on an ephemeral port. The plugin
generates a random bearer token per process, so nothing else on the machine can
query the knowledge base.

## What it does

- Parse Markdown, text-selectable PDF (with PDF bookmarks as section paths) and
  Windows CHM (decompiled with `hh.exe`, 7z fallback; GBK/UTF-8 aware).
- Chunk by heading, keeping fenced code blocks intact and line/page locators.
- Build per-document **TGM** (tree + entity co-occurrence graph + entity→node
  mapping), **BM25** (jieba) and dense vectors (bge-m3, 1024-dim).
- Query with dense + BM25 + TGM fusion (RRF) and an optional bge-reranker.
- Filter by vendor first, then prefer model/version matches; a mismatch is
  surfaced as `partial` instead of silently returning another vendor's commands.

## Manual setup (Windows)

```powershell
E:\Python312\python.exe -m venv E:\dsh-autoconfig-data\.venv
E:\dsh-autoconfig-data\.venv\Scripts\python.exe -m pip install -r sidecar\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
E:\dsh-autoconfig-data\.venv\Scripts\python.exe -m pip install torch==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121
E:\dsh-autoconfig-data\.venv\Scripts\modelscope.exe download --model BAAI/bge-m3 --local_dir E:\dsh-autoconfig-data\models\bge-m3
```

Run it directly for debugging:

```powershell
$env:PYTHONPATH = "D:\...\dsh-autoconfig\sidecar"
E:\dsh-autoconfig-data\.venv\Scripts\python.exe -m bookrag_svc `
  --data-dir E:\dsh-autoconfig-data `
  --model E:\dsh-autoconfig-data\models\bge-m3 `
  --device cuda --port 8765 --token devtoken
```

`GET /health`, `GET /docs`, `POST /search` are protected by the bearer token.
FastAPI's built-in `/docs` was deliberately disabled so the document route can
use that path.

## Tests

```powershell
$env:PYTHONPATH = "D:\...\dsh-autoconfig\sidecar"
E:\dsh-autoconfig-data\.venv\Scripts\python.exe -m unittest discover -s sidecar\tests -p "test_*.py"
```

`smoke_pdf.py` builds a real PDF and prints retrieval results; it is opt-in and
not part of unittest discovery.