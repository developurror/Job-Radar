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
    """Returns canned responses in call order; records prompts and options."""

    provider_name = "scripted"

    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.prompts: list[str] = []
        self.completion_options: list[CompletionOptions | None] = []

    def complete(self, prompt: str, options: CompletionOptions | None = None) -> str:
        self.prompts.append(prompt)
        self.completion_options.append(options)
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


# ---------------------------------------------------------------------------
# Synthesis JSON mode + single retry (fix for the "did not return a JSON
# object" 502: without response-format enforcement, gemma4 answered the
# heavy Phase 11 synthesis prompt in plain prose)
# ---------------------------------------------------------------------------


def test_synthesize_intel_requests_json_mode():
    provider = ScriptedProvider([VALID_INTEL_JSON])
    synthesize_intel("Acme Corp", [], provider)
    assert len(provider.completion_options) == 1
    assert provider.completion_options[0] is not None
    assert provider.completion_options[0].json_mode is True


def test_synthesize_intel_does_not_retry_a_valid_first_reply():
    provider = ScriptedProvider([VALID_INTEL_JSON])
    intel = synthesize_intel("Acme Corp", [], provider)
    assert intel["sentiment"] == "positive"
    assert len(provider.prompts) == 1


def test_synthesize_intel_retries_once_when_first_reply_is_prose():
    provider = ScriptedProvider(
        ["Acme Corp is a fine company with a long history.", VALID_INTEL_JSON]
    )
    intel = synthesize_intel("Acme Corp", [], provider)
    assert intel["summary"].startswith("Acme Corp builds anvils")
    assert len(provider.prompts) == 2
    assert provider.prompts[1].startswith(provider.prompts[0])
    assert "not valid JSON" in provider.prompts[1]
    assert "ONLY the JSON object" in provider.prompts[1]
    assert "not valid JSON" not in provider.prompts[0]
    assert provider.completion_options[1] is not None
    assert provider.completion_options[1].json_mode is True


def test_synthesize_intel_raises_and_reports_raw_reply_after_two_prose_replies(capsys):
    first_prose_reply = "Acme Corp makes anvils and is generally well regarded."
    second_prose_reply = "In summary, employees describe Acme Corp as a stable place."
    provider = ScriptedProvider([first_prose_reply, second_prose_reply])
    with pytest.raises(HermesError, match="did not return a JSON object") as raised_error:
        synthesize_intel("Acme Corp", [], provider)
    assert len(provider.prompts) == 2
    # The raw model text is diagnosable from stderr (container logs)...
    captured = capsys.readouterr()
    assert second_prose_reply in captured.err
    assert str(len(second_prose_reply)) in captured.err
    # ...but never leaks into the raised error shown to the client.
    assert second_prose_reply not in str(raised_error.value)
    assert first_prose_reply not in str(raised_error.value)


# ---------------------------------------------------------------------------
# Extraction robustness, round 2 (live Twikey failure: gemma4 returned a
# JSON object with a missing comma — the decode error escaped
# _extract_json_object unwrapped, so the retry/logging never engaged)
# ---------------------------------------------------------------------------

# A missing comma after the summary string, mirroring the live failure
# ("Expecting ',' delimiter" from json.loads).
MALFORMED_TWIKEY_JSON = (
    '{"summary": "Twikey is a European payment orchestration platform" '
    '"knownFor": ["recurring payments"], "notableProjects": [], '
    '"reputationNotes": "Growth-stage fintech.", "sentiment": "mixed"}'
)

VALID_TWIKEY_JSON = json.dumps(
    {
        "summary": "Twikey is a European payment orchestration platform",
        "knownFor": ["recurring payments"],
        "notableProjects": [],
        "reputationNotes": "Growth-stage fintech.",
        "sentiment": "mixed",
    }
)


def test_synthesize_intel_retries_when_first_reply_is_malformed_json():
    provider = ScriptedProvider([MALFORMED_TWIKEY_JSON, VALID_TWIKEY_JSON])
    intel = synthesize_intel("Twikey", [], provider)
    assert intel["summary"] == "Twikey is a European payment orchestration platform"
    assert intel["sentiment"] == "mixed"
    assert len(provider.prompts) == 2
    assert "not valid JSON" in provider.prompts[1]


def test_synthesize_intel_raises_hermes_error_and_reports_raw_reply_after_two_malformed_replies(capsys):
    second_malformed_reply = MALFORMED_TWIKEY_JSON.replace("European", "Belgian")
    provider = ScriptedProvider([MALFORMED_TWIKEY_JSON, second_malformed_reply])
    with pytest.raises(HermesError, match="malformed JSON") as raised_error:
        synthesize_intel("Twikey", [], provider)
    assert len(provider.prompts) == 2
    captured = capsys.readouterr()
    assert second_malformed_reply in captured.err
    assert str(len(second_malformed_reply)) in captured.err
    # The decode detail reaches the error; the raw reply itself does not.
    assert "Expecting ',' delimiter" in str(raised_error.value)
    assert second_malformed_reply not in str(raised_error.value)


def test_synthesize_intel_salvages_object_before_trailing_prose_with_braces():
    reply_with_trailing_prose = (
        VALID_INTEL_JSON
        + "\n\nNote: the outlook {short term} remains {uncertain} for hiring."
    )
    provider = ScriptedProvider([reply_with_trailing_prose])
    intel = synthesize_intel("Acme Corp", [], provider)
    assert intel["summary"].startswith("Acme Corp builds anvils")
    assert len(provider.prompts) == 1


def test_synthesize_intel_drops_items_citing_the_companys_own_domain():
    evidence_entries = [
        _page_entry(
            "AccuLynx — Best Roofing CRM Software",
            "https://www.acculynx.com/",
            "Our all-in-one platform manages every aspect of your operations.",
        ),
        _page_entry(
            "AccuLynx reviews",
            "https://www.glassdoor.com/Reviews/AccuLynx-Reviews-E123.htm",
            "Employee reviews of AccuLynx.",
        ),
    ]
    intel_json = _split_intel_json(
        positive_items=[
            {"claim": "All-in-one platform covering sales and production", "specificity": 4, "corroboration": 3, "evidenceIndex": 1},
            {"claim": "Protected focus time each week", "specificity": 4, "corroboration": 2, "evidenceIndex": 2},
        ],
        negative_items=[
            {"claim": "Onboarding is entirely self-serve", "specificity": 3, "corroboration": 1, "evidenceIndex": 1},
        ],
    )
    intel = synthesize_intel("AccuLynx", evidence_entries, ScriptedProvider([intel_json]))

    # Only the Glassdoor-cited item survives; both items citing the
    # company's own marketing pages are dropped, from both sections.
    assert [item["claim"] for item in intel["positiveItems"]] == [
        "Protected focus time each week"
    ]
    assert intel["positiveItems"][0]["sourceUrl"].startswith("https://www.glassdoor.com")
    assert intel["negativeItems"] == []


def test_synthesize_intel_keeps_items_from_a_domain_label_that_only_contains_the_company_name():
    evidence_entries = [
        _page_entry(
            "AccuLynx reviewed",
            "https://www.acculynxreviews.com/acculynx",
            "A third-party roundup reviewing AccuLynx.",
        ),
    ]
    intel_json = _split_intel_json(
        positive_items=[
            {"claim": "Praised for responsive support", "specificity": 3, "corroboration": 2, "evidenceIndex": 1},
        ],
        negative_items=[],
    )
    intel = synthesize_intel("AccuLynx", evidence_entries, ScriptedProvider([intel_json]))
    assert [item["claim"] for item in intel["positiveItems"]] == [
        "Praised for responsive support"
    ]


def test_synthesize_intel_drops_items_citing_own_domain_for_name_with_legal_suffix():
    # The live VDart case: "VDart Inc" registers vdart.com, but the full
    # name concatenation is "vdartinc" — the guard must still recognize
    # the company's own pages once the legal-form token is set aside.
    evidence_entries = [
        _page_entry(
            "VDart Origin Story & Company History",
            "https://www.vdart.com/about/origin-story",
            "How VDart grew from a staffing startup into a digital consultancy.",
        ),
        _page_entry(
            "VDart reviews",
            "https://www.glassdoor.com/Reviews/VDart-Reviews-E456.htm",
            "Employee reviews of VDart.",
        ),
    ]
    intel_json = _split_intel_json(
        positive_items=[
            {"claim": "Leadership credits learning partnerships for growth", "specificity": 4, "corroboration": 1, "evidenceIndex": 1},
            {"claim": "Protected focus time each week", "specificity": 4, "corroboration": 2, "evidenceIndex": 2},
        ],
        negative_items=[
            {"claim": "Onboarding is entirely self-serve", "specificity": 3, "corroboration": 1, "evidenceIndex": 1},
        ],
    )
    intel = synthesize_intel("VDart Inc", evidence_entries, ScriptedProvider([intel_json]))

    assert [item["claim"] for item in intel["positiveItems"]] == [
        "Protected focus time each week"
    ]
    assert intel["negativeItems"] == []


def test_synthesize_intel_keeps_review_platform_and_aggregator_items_for_multi_token_name():
    evidence_entries = [
        _page_entry(
            "VDart reviews",
            "https://www.glassdoor.ca/Reviews/VDart-Reviews-E456.htm",
            "Employee reviews of VDart.",
        ),
        _page_entry(
            "VDart reviewed",
            "https://www.vdartreviews.com/vdart",
            "A third-party roundup reviewing VDart.",
        ),
    ]
    intel_json = _split_intel_json(
        positive_items=[
            {"claim": "Praised for responsive support", "specificity": 3, "corroboration": 2, "evidenceIndex": 1},
            {"claim": "Roundup notes strong delivery record", "specificity": 3, "corroboration": 1, "evidenceIndex": 2},
        ],
        negative_items=[],
    )
    intel = synthesize_intel("VDart Inc", evidence_entries, ScriptedProvider([intel_json]))

    # glassdoor.ca is a review platform, and vdartreviews.com merely
    # CONTAINS the company token — neither is the company's own domain.
    assert [item["claim"] for item in intel["positiveItems"]] == [
        "Praised for responsive support",
        "Roundup notes strong delivery record",
    ]


def test_synthesize_intel_drops_items_citing_full_multiword_name_domain():
    evidence_entries = [
        _page_entry(
            "Morgan Properties — About Us",
            "https://www.morganproperties.com/about",
            "A family-owned property management company.",
        ),
        _page_entry(
            "Morgan Properties reviews",
            "https://www.indeed.com/cmp/Morgan-Properties/reviews",
            "Employee reviews of Morgan Properties.",
        ),
    ]
    intel_json = _split_intel_json(
        positive_items=[
            {"claim": "Emphasizes strong customer service and amenities", "specificity": 2, "corroboration": 1, "evidenceIndex": 1},
            {"claim": "Stable schedules for site staff", "specificity": 3, "corroboration": 2, "evidenceIndex": 2},
        ],
        negative_items=[],
    )
    intel = synthesize_intel("Morgan Properties", evidence_entries, ScriptedProvider([intel_json]))

    assert [item["claim"] for item in intel["positiveItems"]] == [
        "Stable schedules for site staff"
    ]
