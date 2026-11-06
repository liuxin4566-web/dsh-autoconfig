# -*- coding: utf-8 -*-
"""BookRAG sidecar for dsh-autoconfig."""
from .server import create_app
from .config import Settings
from .embedder import Embedder
from .search import Registry

__all__ = ["create_app", "Settings", "Embedder", "Registry"]
__version__ = "0.2.7"