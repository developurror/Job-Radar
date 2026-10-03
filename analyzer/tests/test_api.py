"""Endpoint tests. The embedding model is mocked: no weights are downloaded."""
from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from analyzer import embeddings
from analyzer.config import AnalyzerSettings
from analyzer.main import create_app
from analyzer.providers.openai_compatible import OpenAiCompatibleProvider


def build_test_client(monkeypatch) -> TestClient:
    monkeypatch.setattr(
        embeddings,
        "embed_texts",
        lambda texts, model_name="": [[0.1, 0.2, 0.3] for _ in texts],
    )
    # Keep /health hermetic: no real backend is running in the test sandbox.
    monkeypatch.setattr(OpenAiCompatibleProvider, "ping", lambda self: True)
    return TestClient(create_app(AnalyzerSettings()))


def test_health_reports_provider_wiring(monkeypatch):
    client = build_test_client(monkeypatch)
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["triage_provider"] == "ollama"
    assert body["deep_provider"] == "ollama"
    assert body["triage_reachable"] is True
    assert body["deep_reachable"] is True
    assert body["embedding_model"] == "bge-small-en-v1.5"


def test_embed_returns_one_vector_per_text(monkeypatch):
    client = build_test_client(monkeypatch)
    response = client.post("/v1/embed", json={"texts": ["hello world", "second text"]})
    assert response.status_code == 200
    body = response.json()
    assert len(body["vectors"]) == 2
    assert body["vectors"][0] == [0.1, 0.2, 0.3]
    assert body["dimensions"] == 3
    assert body["model"] == "BAAI/bge-small-en-v1.5"


def test_embed_rejects_empty_text_list(monkeypatch):
    client = build_test_client(monkeypatch)
    response = client.post("/v1/embed", json={"texts": []})
    assert response.status_code == 422


def test_ping_returns_false_when_backend_unreachable():
    provider = OpenAiCompatibleProvider(
        provider_name="probe", base_url="http://127.0.0.1:1", model="probe-model"
    )

    def raise_connection_error(*args, **kwargs):
        raise httpx.ConnectError("connection refused")

    provider._http_client.get = raise_connection_error
    assert provider.ping() is False


def test_generate_returns_provider_text(monkeypatch):
    client = build_test_client(monkeypatch)
    monkeypatch.setattr(
        OpenAiCompatibleProvider,
        "complete",
        lambda self, prompt, options=None: '{"verdict": "pass", "evidence": "remote mentioned"}',
    )
    response = client.post("/v1/generate", json={"prompt": "Is this job remote?", "max_tokens": 128})
    assert response.status_code == 200
    body = response.json()
    assert body["text"] == '{"verdict": "pass", "evidence": "remote mentioned"}'
    assert body["provider"] == "ollama"


def test_generate_rejects_empty_prompt(monkeypatch):
    client = build_test_client(monkeypatch)
    response = client.post("/v1/generate", json={"prompt": ""})
    assert response.status_code == 422
