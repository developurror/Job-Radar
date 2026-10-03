"""Learned-match tests (Phase 6). The embedding model is mocked with a
deterministic keyword fake so the logistic regression separates cleanly:
texts containing 'good' embed to [1, 0], everything else to [0, 1]."""
from __future__ import annotations

from fastapi.testclient import TestClient

from analyzer import embeddings, learning
from analyzer.config import AnalyzerSettings
from analyzer.main import create_app
from analyzer.providers.openai_compatible import OpenAiCompatibleProvider


def fake_embed_texts(texts, model_name=""):
    return [[1.0, 0.0] if "good" in text else [0.0, 1.0] for text in texts]


def build_test_client(monkeypatch) -> TestClient:
    monkeypatch.setattr(embeddings, "embed_texts", fake_embed_texts)
    # Keep /health hermetic: no real backend is running in the test sandbox.
    monkeypatch.setattr(OpenAiCompatibleProvider, "ping", lambda self: True)
    return TestClient(create_app(AnalyzerSettings()))


def make_examples(positive_count: int, negative_count: int) -> list[dict]:
    examples = []
    for index in range(positive_count):
        examples.append({"text": f"good posting {index}", "label": "up"})
    for index in range(negative_count):
        examples.append({"text": f"bad posting {index}", "label": "down"})
    return examples


def test_not_ready_below_minimum_total_labels():
    result = learning.score_targets(
        make_examples(6, 4),
        [{"id": 1, "text": "good target"}],
        fake_embed_texts,
    )
    assert result["modelReady"] is False
    assert result["labelCount"] == 10
    assert result["positiveCount"] == 6
    assert result["negativeCount"] == 4
    assert result["scores"] == []


def test_not_ready_with_a_single_class():
    result = learning.score_targets(
        make_examples(20, 0),
        [{"id": 1, "text": "good target"}],
        fake_embed_texts,
    )
    assert result["modelReady"] is False
    assert result["labelCount"] == 20
    assert result["positiveCount"] == 20
    assert result["negativeCount"] == 0
    assert result["scores"] == []


def test_unknown_labels_are_ignored_entirely():
    examples = make_examples(3, 3)
    examples.append({"text": "good but unlabeled", "label": "maybe"})
    examples.append({"text": "good but blank", "label": ""})
    result = learning.score_targets(examples, [], fake_embed_texts)
    assert result["modelReady"] is False
    assert result["labelCount"] == 6
    assert result["positiveCount"] == 3
    assert result["negativeCount"] == 3
    assert result["scores"] == []


def test_ready_model_scores_good_targets_high_and_bad_targets_low():
    result = learning.score_targets(
        make_examples(12, 12),
        [
            {"id": 101, "text": "a good target posting"},
            {"id": 102, "text": "a bad target posting"},
        ],
        fake_embed_texts,
    )
    assert result["modelReady"] is True
    assert result["labelCount"] == 24
    assert result["positiveCount"] == 12
    assert result["negativeCount"] == 12
    scores_by_id = {entry["id"]: entry["probability"] for entry in result["scores"]}
    assert scores_by_id[101] > 50
    assert scores_by_id[102] < 50
    for probability in scores_by_id.values():
        assert 0 <= probability <= 100


def test_ready_model_with_empty_targets_returns_no_scores():
    result = learning.score_targets(make_examples(12, 12), [], fake_embed_texts)
    assert result["modelReady"] is True
    assert result["scores"] == []


def test_endpoint_reports_not_ready_with_insufficient_labels(monkeypatch):
    client = build_test_client(monkeypatch)
    response = client.post(
        "/v1/learn/score-batch",
        json={
            "examples": make_examples(3, 2),
            "targets": [{"id": 1, "text": "good target"}],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["modelReady"] is False
    assert body["labelCount"] == 5
    assert body["positiveCount"] == 3
    assert body["negativeCount"] == 2
    assert body["scores"] == []


def test_endpoint_scores_targets_when_model_is_ready(monkeypatch):
    client = build_test_client(monkeypatch)
    response = client.post(
        "/v1/learn/score-batch",
        json={
            "examples": make_examples(12, 12),
            "targets": [{"id": 7, "text": "a good target posting"}],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["modelReady"] is True
    assert body["scores"][0]["id"] == 7
    assert body["scores"][0]["probability"] > 50
