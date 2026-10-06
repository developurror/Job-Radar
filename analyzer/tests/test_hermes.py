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


def test_plan_search_queries_parses_tracks_and_caps(monkeypatch):
    planner_reply = json.dumps(
        {
            "blendedQueries": ["b1", "b2", "b3"],
            "positiveQueries": ["p1", "p2", "p3"],
            "negativeQueries": ["n1", "n2", "n3"],
        }
    )
    monkeypatch.setattr(
        ScriptedProvider, "complete", lambda self, prompt, options=None: planner_reply
    )
    planned_queries = plan_search_queries("Acme Corp", ScriptedProvider([]))
    assert [(planned.query, planned.track) for planned in planned_queries] == [
        ("b1", "blended"),
        ("b2", "blended"),
        ("p1", "positive"),
        ("p2", "positive"),
        ("n1", "negative"),
        ("n2", "negative"),
    ]
    assert len(planned_queries) <= MAX_PLANNED_QUERIES


def test_plan_search_queries_accepts_legacy_array_as_blended(monkeypatch):
    monkeypatch.setattr(
        ScriptedProvider,
        "complete",
        lambda self, prompt, options=None: '["q1","q2","q3"]',
    )
    planned_queries = plan_search_queries("Acme Corp", ScriptedProvider([]))
    assert [(planned.query, planned.track) for planned in planned_queries] == [
        ("q1", "blended"),
        ("q2", "blended"),
        ("q3", "blended"),
    ]


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


# ---------------------------------------------------------------------------
# Phase 11 (F13): split synthesis, citation enforcement, identity verification
# ---------------------------------------------------------------------------


def _split_intel_json(positive_items: list, negative_items: list) -> str:
    return json.dumps(
        {
            "summary": "Acme Corp builds anvils for cartoon coyotes.",
            "knownFor": ["anvils"],
            "notableProjects": [],
            "reputationNotes": "Some signals found.",
            "sentiment": "mixed",
            "positiveItems": positive_items,
            "negativeItems": negative_items,
        }
    )


def _page_entry(title: str, url: str, text: str) -> hermes.EvidenceEntry:
    return hermes.EvidenceEntry(title=title, url=url, text=text, track="blended", kind="signal")


def test_synthesize_intel_normalizes_split_items_with_bands_and_sources():
    evidence_entries = [
        _page_entry("Acme reviews", "https://example.com/reviews", "Praise and complaints."),
        _page_entry("Acme careers", "https://example.com/careers", "Benefits page."),
    ]
    intel_json = _split_intel_json(
        positive_items=[
            {"claim": "Two hours a week of protected development time", "specificity": 4, "corroboration": 12, "evidenceIndex": 1},
            {"claim": "Friendly team", "specificity": 3, "corroboration": 2, "evidenceIndex": 2},
        ],
        negative_items=[
            {"claim": "Bad vibes", "specificity": 0, "corroboration": 1, "evidenceIndex": 1},
        ],
    )
    intel = synthesize_intel("Acme Corp", evidence_entries, ScriptedProvider([intel_json]))

    assert intel["evidenceStatus"] == "sufficient"
    assert intel["positiveItems"][0]["specificityBand"] == "high"
    assert intel["positiveItems"][0]["sourceTitle"] == "Acme reviews"
    assert intel["positiveItems"][0]["sourceUrl"] == "https://example.com/reviews"
    assert intel["positiveItems"][0]["kind"] == "signal"
    assert intel["positiveItems"][0]["corroboration"] == 12
    assert intel["positiveItems"][1]["specificityBand"] == "medium"
    assert intel["negativeItems"][0]["specificityBand"] == "generic"
    assert intel["genericPraiseCluster"] is False


def test_synthesize_intel_drops_items_without_a_valid_citation():
    evidence_entries = [_page_entry("Acme reviews", "https://example.com/reviews", "Text.")]
    intel_json = _split_intel_json(
        positive_items=[
            {"claim": "No index at all", "specificity": 5, "corroboration": 3},
            {"claim": "Index out of range", "specificity": 5, "corroboration": 3, "evidenceIndex": 99},
            {"claim": "Index of the wrong type", "specificity": 5, "corroboration": 3, "evidenceIndex": "1"},
            {"claim": "", "specificity": 5, "corroboration": 3, "evidenceIndex": 1},
        ],
        negative_items=[],
    )
    intel = synthesize_intel("Acme Corp", evidence_entries, ScriptedProvider([intel_json]))
    assert intel["positiveItems"] == []


def test_synthesize_intel_caps_and_orders_items_per_section():
    evidence_entries = [_page_entry("Acme reviews", "https://example.com/reviews", "Text.")]
    positive_items = [
        {"claim": f"Point {index}", "specificity": specificity, "corroboration": 1, "evidenceIndex": 1}
        for index, specificity in enumerate([1, 5, 3, 4, 2])
    ]
    intel = synthesize_intel(
        "Acme Corp", evidence_entries, ScriptedProvider([_split_intel_json(positive_items, [])])
    )
    assert len(intel["positiveItems"]) == hermes.MAX_ITEMS_PER_SECTION
    assert [item["claim"] for item in intel["positiveItems"]] == ["Point 1", "Point 3", "Point 2"]


def test_synthesize_intel_flags_generic_praise_cluster():
    evidence_entries = [_page_entry("Acme reviews", "https://example.com/reviews", "Text.")]
    clustered_json = _split_intel_json(
        positive_items=[
            {"claim": "Great culture", "specificity": 0, "corroboration": 14253, "evidenceIndex": 1},
            {"claim": "Amazing place to settle", "specificity": 1, "corroboration": 900, "evidenceIndex": 1},
        ],
        negative_items=[],
    )
    intel = synthesize_intel("Acme Corp", evidence_entries, ScriptedProvider([clustered_json]))
    assert intel["genericPraiseCluster"] is True

    quiet_json = _split_intel_json(
        positive_items=[
            {"claim": "Great culture", "specificity": 0, "corroboration": 3, "evidenceIndex": 1},
            {"claim": "Nice team", "specificity": 1, "corroboration": 2, "evidenceIndex": 1},
        ],
        negative_items=[],
    )
    intel = synthesize_intel("Acme Corp", evidence_entries, ScriptedProvider([quiet_json]))
    assert intel["genericPraiseCluster"] is False


def test_page_belongs_to_company_matching_rules():
    assert hermes.page_belongs_to_company(
        "Busbud", "Busbud Reviews", "https://www.glassdoor.com/Reviews/Busbud-Reviews-E1.htm", ""
    )
    assert not hermes.page_belongs_to_company(
        "Busbud",
        "Bus.com Reviews",
        "https://www.glassdoor.com/Reviews/Bus-Com-Reviews-E2.htm",
        "Bus.com is a charter bus marketplace. Riders and drivers review Bus.com here.",
    )
    assert hermes.page_belongs_to_company(
        "Tata Consultancy Services", "TCS Reviews", "https://ca.indeed.com/cmp/Tcs", ""
    )
    assert hermes.page_belongs_to_company(
        "Acme Corp", "Homepage", "https://example.com/", "Acme Corp builds anvils."
    )
    assert not hermes.page_belongs_to_company(
        "Acme Corp", "Unrelated", "https://example.com/other", "Nothing about anyone."
    )


def test_analyze_company_returns_insufficient_when_pages_belong_to_another_company():
    def fake_search(query: str) -> list[SearchResult]:
        return [SearchResult(title="Bus.com Reviews", url="https://www.glassdoor.com/bus-com")]

    def fake_fetch(url: str) -> str:
        return "Bus.com is a different company entirely; people review Bus.com here."

    # Only the planner response is scripted: synthesis must never be called.
    provider = ScriptedProvider(['["Busbud reviews"]'])
    intel = analyze_company("Busbud", provider, search_fn=fake_search, fetch_fn=fake_fetch)

    assert intel["evidenceStatus"] == "insufficient"
    assert intel["sentiment"] == "unknown"
    assert intel["positiveItems"] == []
    assert intel["negativeItems"] == []


def test_analyze_company_uses_supplied_review_evidence_when_search_finds_nothing():
    def empty_search(query: str) -> list[SearchResult]:
        return []

    def unused_fetch(url: str) -> str:
        raise AssertionError("no page fetch expected")

    synthesis_json = _split_intel_json(
        positive_items=[
            {"claim": "Unlimited PTO that people actually take", "specificity": 4, "corroboration": 1, "evidenceIndex": 1}
        ],
        negative_items=[],
    )
    provider = ScriptedProvider(['["Busbud reviews"]', synthesis_json])
    intel = analyze_company(
        "Busbud",
        provider,
        search_fn=empty_search,
        fetch_fn=unused_fetch,
        review_evidence=[
            {
                "text": "Pros: unlimited PTO, and yes, people still take vacation.",
                "sourceTitle": "Glassdoor review — Engineer",
                "sourceUrl": "https://www.glassdoor.com/reviews/busbud",
            }
        ],
    )

    assert intel["evidenceStatus"] == "sufficient"
    assert intel["positiveItems"][0]["kind"] == "review"
    assert intel["positiveItems"][0]["sourceTitle"] == "Glassdoor review — Engineer"


def test_analyze_company_fetches_review_platform_pages_first():
    fetched_urls: list[str] = []

    def fake_search(query: str) -> list[SearchResult]:
        results = [
            SearchResult(title=f"Blog {index}", url=f"https://blog{index}.example.com/acme-corp")
            for index in range(11)
        ]
        results.append(
            SearchResult(title="Acme Corp Reviews", url="https://www.glassdoor.com/acme-corp")
        )
        return results

    def fake_fetch(url: str) -> str:
        fetched_urls.append(url)
        return "Acme Corp page text."

    provider = ScriptedProvider(['["Acme Corp reviews"]', VALID_INTEL_JSON])
    analyze_company("Acme Corp", provider, search_fn=fake_search, fetch_fn=fake_fetch)

    assert fetched_urls[0] == "https://www.glassdoor.com/acme-corp"
    assert len(fetched_urls) <= MAX_FETCHED_PAGES
