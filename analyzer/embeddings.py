"""Sentence-transformers embedding singleton, lazy-loaded on first use (CPU).

The model is loaded once and reused across requests. Loading is deferred so the
service boots fast and tests can run without downloading any model weights.
"""
from __future__ import annotations

from threading import Lock

_embedding_model = None
_loaded_model_name: str | None = None
_load_lock = Lock()


def resolve_model_name(model_name: str) -> str:
    """Expand short BAAI names (``bge-small-en-v1.5``) to their Hub id."""
    if "/" in model_name:
        return model_name
    if model_name.startswith("bge-"):
        return f"BAAI/{model_name}"
    return model_name


def _load_embedding_model(model_name: str):
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(resolve_model_name(model_name), device="cpu")


def embed_texts(texts: list[str], model_name: str = "bge-small-en-v1.5") -> list[list[float]]:
    """Embed a batch of texts. Returns L2-normalized vectors (cosine-ready)."""
    global _embedding_model, _loaded_model_name
    if not texts:
        return []
    with _load_lock:
        if _embedding_model is None or _loaded_model_name != model_name:
            _embedding_model = _load_embedding_model(model_name)
            _loaded_model_name = model_name
        raw_vectors = _embedding_model.encode(texts, normalize_embeddings=True)
    return [[float(component) for component in vector] for vector in raw_vectors]
