"""Hermes agent tests. Web search and page fetching are mocked: the agent loop,
budgets, and intel parsing are tested without any network access."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from analyzer import embeddings, hermes
from analyzer.config import AnalyzerSettings
from analyzer.hermes import (
    MAX_FETCHED_PAGES,
    MAX_PLANNED_QUERIES,
    HermesError,
    SearchResult,
    analyze_company,
    plan_search_queries,
    synthesize_intel,
)
from analyzer.main import create_app
from analyzer.providers.base import CompletionOptions, LlmProvider


class ScriptedProvider(LlmProvider):
    """Returns canned responses in call order."""

    provider_name = "scripted"

    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.prompts: list[str] = []

    def complete(self, prompt: str, options: CompletionOptions | None = None) -> str:
        self.prompts.append(prompt)
        return self.responses.pop(0)

    def complete_with_tools(self, prompt: str, tools: list[dict]):
        raise NotImplementedError

    def ping(self) -> bool:
        return True

    def close(self) -> None:
        pass


VALID_INTEL_JSON = json.dumps(
    {
        "summary": "Acme Corp builds anvils for cartoon coyotes.",
        "knownFor": ["anvils", "rocket skates"],
        "notableProjects": ["Super Anvil 3000"],
        "reputationNotes": "Generally liked; occasional delivery delays.",
        "sentiment": "positive",
    }
)


def test_plan_search_queries_parses_and_caps(monkeypatch):
    monkeypatch.setattr(
        ScriptedProvider, "complete", lambda self, prompt, options=None: '["q1","q2","q3","q4","q5","q6"]'
    )
    queries = plan_search_queries("Acme Corp", ScriptedProvider([]))
    assert queries == ["q1", "q2", "q3", "q4"]
    assert len(queries) <= MAX_PLANNED_QUERIES


def test_plan_search_queries_rejects_garbage():
    provider = ScriptedProvider(["no json here at all"])
    with pytest.raises(HermesError):
        plan_search_queries("Acme Corp", provider)


def test_plan_search_queries_reports_empty_model_response():
    provider = ScriptedProvider([""])
    with pytest.raises(HermesError, match="no content"):
        plan_search_queries("Acme Corp", provider)


def test_synthesize_intel_reports_empty_model_response():
    provider = ScriptedProvider(["   "])
    with pytest.raises(HermesError, match="no content"):
        synthesize_intel("Acme Corp", [], provider)


def test_analyze_company_respects_budgets():
    planned_queries: list[str] = []
    fetched_urls: list[str] = []

    def fake_search(query: str) -> list[SearchResult]:
        planned_queries.append(query)
        return [SearchResult(title=f"Result {index}", url=f"https://example.com/{query}/{index}") for index in range(10)]

    def fake_fetch(url: str) -> str:
        fetched_urls.append(url)
        return f"Page text about the company from {url}."

    provider = ScriptedProvider(
        ['["Acme Corp what do they do","Acme Corp reviews","Acme Corp layoffs","Acme Corp tech stack","Acme Corp extra query"]', VALID_INTEL_JSON]
    )
    intel = analyze_company("Acme Corp", provider, search_fn=fake_search, fetch_fn=fake_fetch)

    assert len(planned_queries) <= MAX_PLANNED_QUERIES
    assert len(fetched_urls) <= MAX_FETCHED_PAGES
    assert intel["sentiment"] == "positive"
    assert "anvils" in intel["summary"]


def test_analyze_company_rejects_empty_name():
    with pytest.raises(HermesError):
        analyze_company("   ", ScriptedProvider([]))


def test_synthesize_intel_normalizes_unknown_sentiment():
    intel_json = json.dumps(
        {
            "summary": "A company.",
            "knownFor": ["things"],
            "notableProjects": [],
            "reputationNotes": "Nothing known.",
            "sentiment": "glowing",
        }
    )
    intel = synthesize_intel("Acme", [], ScriptedProvider([intel_json]))
    assert intel["sentiment"] == "unknown"


def test_synthesize_intel_rejects_empty_summary():
    intel_json = json.dumps({"summary": "", "knownFor": [], "notableProjects": [], "reputationNotes": "", "sentiment": "mixed"})
    with pytest.raises(HermesError):
        synthesize_intel("Acme", [], ScriptedProvider([intel_json]))


def test_parse_duckduckgo_lite_extracts_results():
    page_html = """
    <table><tr><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Facme&amp;rut=abc">Acme Corp <b>home</b></a>
    </td></tr><tr><td>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Fexample.org%2Freviews&amp;rut=def">Acme reviews</a>
    </td></tr></table>
    """
    results = hermes._parse_duckduckgo_lite(page_html)
    assert [result.url for result in results] == [
        "https://example.com/acme",
        "http://example.org/reviews",
    ]
    assert results[0].title == "Acme Corp home"


def test_html_to_text_strips_tags():
    page_html = "<html><head><style>.x{color:red}</style><script>alert(1)</script></head><body><h1>Hi</h1><p>a &amp; b</p></body></html>"
    assert hermes._html_to_text(page_html) == "Hi a & b"


def build_company_client(monkeypatch) -> TestClient:
    monkeypatch.setattr(
        embeddings, "embed_texts", lambda texts, model_name="": [[0.1] for _ in texts]
    )
    from analyzer.providers.openai_compatible import OpenAiCompatibleProvider

    monkeypatch.setattr(OpenAiCompatibleProvider, "ping", lambda self: True)
    responses = [
        '["Acme Corp what do they do", "Acme Corp reviews"]',
        VALID_INTEL_JSON,
    ]
    monkeypatch.setattr(
        OpenAiCompatibleProvider, "complete", lambda self, prompt, options=None: responses.pop(0)
    )
    monkeypatch.setattr(
        hermes,
        "web_search",
        lambda query: [SearchResult(title="Acme home", url="https://example.com/acme")],
    )
    monkeypatch.setattr(hermes, "fetch_page", lambda url: "Acme Corp builds anvils.")
    return TestClient(create_app(AnalyzerSettings()))


def test_analyze_company_endpoint_returns_intel(monkeypatch):
    client = build_company_client(monkeypatch)
    response = client.post("/v1/analyze/company", json={"companyName": "Acme Corp"})
    assert response.status_code == 200
    intel = response.json()["intel"]
    assert intel["summary"].startswith("Acme Corp builds anvils")
    assert intel["sentiment"] == "positive"
    assert intel["knownFor"] == ["anvils", "rocket skates"]


def test_analyze_company_endpoint_rejects_blank_name(monkeypatch):
    client = build_company_client(monkeypatch)
    response = client.post("/v1/analyze/company", json={"companyName": "  "})
    # Blank names fail inside the agent loop -> 502 with a clear message.
    assert response.status_code == 502
    assert "empty" in response.json()["detail"]
