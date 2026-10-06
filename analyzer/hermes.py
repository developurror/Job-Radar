"""Hermes: deep company-intel agent (spec F8, split synthesis per F13).

Agentic loop: the LLM plans a small set of web-search queries for a company
name (general, positive-track, and negative-track), the agent runs them
through ``web_search``, fetches the top pages through ``fetch_page``, verifies
each fetched page actually belongs to the company, and the LLM synthesizes a
structured intel object from the verified evidence.

Privacy: only the company name ever leaves the machine (as a search query).
No profile, job-seeker, or job-posting data is sent anywhere.

Politeness budgets are fixed and small: at most 6 planned queries (2 per
track), at most 9 fetched pages, 10s per HTTP request, ~6KB of text kept
per page. Review-platform pages (Glassdoor, Indeed) are fetched first —
the Phase 11 spike found snippet evidence thinnest in the mid-band, and
review platforms carry the densest reputation evidence.

Split synthesis (upgrade spec §4.5/§4.6): alongside the blended summary and
sentiment (retained as derived fields — the reputation factor consumes
them unchanged), the synthesizer emits up to 3 positive and 3 negative
evidence ITEMS. Each item must cite the evidence entry it came from; the
citation is enforced mechanically in ``_normalize_intel`` (an item citing
a missing entry is dropped, not trusted). Items carry a specificity BAND
(high/medium/generic, from the spike's 0-5 rubric) and a corroboration
count — two separate signals, per the spike. When no fetched page can be
verified as belonging to the company and no pre-verified review evidence
was supplied, the result is the required "insufficient verified evidence"
state instead of a synthesis built on another company's pages.
"""
from __future__ import annotations

import html
import json
import re
import sys
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from .providers.base import CompletionOptions, LlmProvider

MAX_PLANNED_QUERIES = 6
MAX_QUERIES_PER_TRACK = 2
MAX_FETCHED_PAGES = 9
REQUEST_TIMEOUT_SECONDS = 10.0
MAX_PAGE_BYTES = 256 * 1024
MAX_PAGE_CHARS = 6000
MAX_EVIDENCE_CHARS = 16000
MAX_ITEMS_PER_SECTION = 3
MAX_REVIEW_EVIDENCE_ITEMS = 20
MAX_REVIEW_EVIDENCE_CHARS = 2000
USER_AGENT = "JobRadarHermes/0.1 (local company-research agent; contact: n/a)"

VALID_SENTIMENTS = ("positive", "mixed", "negative", "unknown")
VALID_TRACKS = ("blended", "positive", "negative")

# Hosts whose pages are review platforms; their evidence is fetched first.
REVIEW_PLATFORM_HOST_MARKERS = ("glassdoor.", "indeed.")

# A generic-praise cluster (spec §4.2/§4.6): at least this many of the top
# positive items are generic-band AND at least one of them is corroborated
# at or above this count (a vague phrase repeated at scale is the pattern).
GENERIC_PRAISE_CLUSTER_MIN_GENERIC_ITEMS = 2
GENERIC_PRAISE_CLUSTER_MIN_CORROBORATION = 100

# Appended to the synthesis prompt for the single retry after a non-JSON
# reply: the Phase 11 synthesis prompt is heavy, and without the required
# shape restated bluntly, local models answer it in plain prose — which
# extraction then rejects (the "did not return a JSON object" 502).
SYNTHESIS_RETRY_CORRECTION = (
    "\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON "
    "object described above — no prose, no explanation, no markdown fences."
)

# How much of an unparseable synthesis response is dumped to stderr: enough
# to recognize what the model actually did, not a full evidence echo.
MAX_REPORTED_RESPONSE_CHARS = 1500

# Name tokens that carry no identity (legal forms), ignored when deriving
# a company's distinctive token / acronym for identity verification.
LEGAL_NAME_SUFFIX_TOKENS = {
    "inc", "ltd", "llc", "llp", "corp", "corporation", "company", "co",
    "group", "holdings", "plc", "sa", "ag", "gmbh", "bv", "nv", "srl",
}


class HermesError(Exception):
    """The agent could not produce intel (network, parse, or LLM failure)."""


@dataclass
class SearchResult:
    title: str
    url: str


@dataclass
class PlannedQuery:
    query: str
    track: str  # one of VALID_TRACKS


@dataclass
class EvidenceEntry:
    """One piece of evidence the synthesis may cite.

    kind "signal": a fetched web page (search-surfaced evidence).
    kind "review": a literal employee review supplied pre-verified by the
    caller (the OpenWeb Ninja Glassdoor path, identity resolved by the
    API's company ID before it reaches the analyzer).
    """

    title: str
    url: str
    text: str
    track: str  # search track that surfaced it, or "api" for reviews
    kind: str  # "signal" | "review"


def plan_search_queries(company_name: str, provider: LlmProvider) -> list[PlannedQuery]:
    """Ask the LLM for web-search queries about the company; sanitize + cap.

    The planner emits three tracks (upgrade spec §4.3.4): general queries
    (what the company does, its reputation), a positive track (what
    employees praise), and a negative track (complaints, layoffs, cons).
    A plain JSON array reply (the pre-F13 shape) is accepted as all-general.
    """
    prompt = (
        f'You are researching the company "{company_name}" for a job seeker. '
        "Propose web search queries in three groups: general queries that "
        "reveal what the company does and its overall reputation; positive "
        "queries that surface what employees praise (best aspects, pros, "
        "benefits); and negative queries that surface complaints (cons, "
        "worst aspects, layoffs, management problems). Reply with ONLY a "
        "JSON object with keys \"blendedQueries\", \"positiveQueries\", and "
        "\"negativeQueries\", each an array of up to 2 query strings, e.g. "
        f'{{"blendedQueries": ["{company_name} what do they do", '
        f'"{company_name} reviews"], "positiveQueries": '
        f'["{company_name} employee reviews pros"], "negativeQueries": '
        f'["{company_name} employee complaints cons"]}}.'
    )
    raw_response = _require_response_content(
        provider.complete(prompt, CompletionOptions(max_tokens=1024, temperature=0.2))
    )
    track_queries = _extract_track_queries(raw_response)
    planned_queries: list[PlannedQuery] = []
    if track_queries is not None:
        for track in VALID_TRACKS:
            for query in track_queries.get(track, [])[:MAX_QUERIES_PER_TRACK]:
                planned_queries.append(PlannedQuery(query=query, track=track))
    else:
        legacy_queries = _extract_json_array(raw_response)
        for query in legacy_queries:
            cleaned_query = query.strip()
            if cleaned_query:
                planned_queries.append(PlannedQuery(query=cleaned_query, track="blended"))
    return planned_queries[:MAX_PLANNED_QUERIES]


def web_search(query: str, http_client: httpx.Client | None = None) -> list[SearchResult]:
    """Keyless web search via DuckDuckGo's lite endpoint. Returns title/url pairs."""
    client = http_client or httpx.Client(
        timeout=REQUEST_TIMEOUT_SECONDS, headers={"User-Agent": USER_AGENT}
    )
    should_close = http_client is None
    try:
        search_url = "https://lite.duckduckgo.com/lite/?q=" + urllib.parse.quote_plus(query)
        response = client.get(search_url)
        response.raise_for_status()
        return _parse_duckduckgo_lite(response.text)
    except Exception:
        return []
    finally:
        if should_close:
            client.close()


def fetch_page(url: str, http_client: httpx.Client | None = None) -> str:
    """Fetch a page and extract plain text. Returns "" on any failure."""
    client = http_client or httpx.Client(
        timeout=REQUEST_TIMEOUT_SECONDS,
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
    )
    should_close = http_client is None
    try:
        response = client.get(url)
        response.raise_for_status()
        page_html = response.text[:MAX_PAGE_BYTES]
        return _html_to_text(page_html)[:MAX_PAGE_CHARS]
    except Exception:
        return ""
    finally:
        if should_close:
            client.close()


def page_belongs_to_company(
    company_name: str, page_title: str, page_url: str, page_text: str
) -> bool:
    """Identity verification (spec §4.6.3): does this page concern THIS company?

    Exact/normalized matching only — never fuzzy. A page passes when the
    full normalized company name appears in its title/URL or text, or when
    a distinctive name token (or the name's acronym, for multi-word names)
    appears in the title/URL. This is what keeps a near-name company's
    reviews (the spike's Busbud vs Bus.com case) out of the synthesis.
    """
    normalized_name = _normalize_for_matching(company_name)
    if not normalized_name:
        return False
    title_url_text = _normalize_for_matching(f"{page_title} {page_url}")
    if _contains_phrase(title_url_text, normalized_name):
        return True
    if _contains_phrase(_normalize_for_matching(page_text[:3000]), normalized_name):
        return True
    identity_tokens = [
        token for token in normalized_name.split() if token not in LEGAL_NAME_SUFFIX_TOKENS
    ]
    if not identity_tokens:
        return False
    distinctive_token = max(identity_tokens, key=len)
    if len(distinctive_token) >= 4 and _contains_phrase(title_url_text, distinctive_token):
        return True
    if len(identity_tokens) >= 2:
        acronym = "".join(token[0] for token in identity_tokens)
        if _contains_phrase(title_url_text, acronym):
            return True
    return False


def synthesize_intel(
    company_name: str,
    evidence_entries: list[EvidenceEntry],
    provider: LlmProvider,
) -> dict:
    """Ask the LLM to synthesize the intel object from gathered evidence."""
    if evidence_entries:
        evidence_text = "\n\n".join(
            f"[Evidence {entry_number}] ({_describe_evidence_entry(entry)}) "
            f"{entry.title} ({entry.url})\n{entry.text}"
            for entry_number, entry in enumerate(evidence_entries, start=1)
        )[:MAX_EVIDENCE_CHARS]
    else:
        evidence_text = "(no pages could be fetched; rely on general knowledge and say so)"
    prompt = (
        f'Researching the company "{company_name}". Evidence:\n\n{evidence_text}\n\n'
        "Summarize for a job seeker. Reply with ONLY a JSON object with these "
        'keys: "summary" (2-3 sentences on what the company does), '
        '"knownFor" (array of short strings: products, reputation, culture), '
        '"notableProjects" (array of short strings: flagship products or projects), '
        '"reputationNotes" (2-3 sentences: reviews, layoffs, controversies, or '
        '"no notable reputation signals found"), "sentiment" (one of '
        '"positive", "mixed", "negative", "unknown"), plus two arrays of '
        'evidence items: "positiveItems" (points in the company\'s favour) '
        'and "negativeItems" (points against it). Each item is an object '
        '{"claim", "specificity", "corroboration", "evidenceIndex"}: '
        '"claim" is one sentence stating a specific point, supported ONLY by '
        'the cited evidence entry; "evidenceIndex" is that entry\'s number '
        "(items without a valid evidenceIndex are discarded by the program, "
        'so never invent one); "corroboration" is how widely the point is '
        "supported — the number of independent sources, or the repetition "
        "count when the evidence itself states one (e.g. a phrase reported "
        'in 14,000 reviews), otherwise 1; "specificity" scores the claim '
        "0-5, one point each for: naming a concrete practice, policy, or "
        "mechanism; quantifying (numbers, magnitudes); describing a specific "
        "incident or sequence of events; being checkable (a named program, "
        "date, place, or person); explaining HOW the mechanism works. Pure "
        'praise or blame adjectives ("great culture", "bad management") '
        "score 0. Give at most 5 items per array, most specific first. If a "
        "side has no supported points, return an empty array for it — never "
        "invent points to fill a side. Items must be drawn from review or "
        "reporting sources (employee-review platforms, news, third-party "
        "reporting): the company's own website and marketing pages may "
        'inform "summary", "knownFor", and "notableProjects", but must '
        "never be cited as an item."
    )
    # JSON mode is requested explicitly: without response-format
    # enforcement, gemma-class local models answer this heavy prompt in
    # plain prose containing no JSON object at all, and extraction fails.
    synthesis_options = CompletionOptions(max_tokens=3072, temperature=0.2, json_mode=True)
    raw_response = _require_response_content(provider.complete(prompt, synthesis_options))
    try:
        intel = _extract_json_object(raw_response)
    except HermesError:
        # One retry with a corrective instruction — and only for the
        # extraction failure. Provider/transport errors propagate as-is.
        retry_response = _require_response_content(
            provider.complete(prompt + SYNTHESIS_RETRY_CORRECTION, synthesis_options)
        )
        try:
            intel = _extract_json_object(retry_response)
        except HermesError:
            _print_unparseable_synthesis_response(retry_response)
            raise
    return _normalize_intel(intel, evidence_entries, company_name)


def analyze_company(
    company_name: str,
    provider: LlmProvider,
    search_fn: Callable[[str], list[SearchResult]] | None = None,
    fetch_fn: Callable[[str], str] | None = None,
    review_evidence: list[dict[str, str]] | None = None,
) -> dict:
    """Run the full agent loop for one company. Raises HermesError on failure.

    ``review_evidence`` is optional pre-verified employee-review evidence
    (the OpenWeb Ninja path): entries of {text, sourceTitle, sourceUrl}
    whose company identity the caller already resolved. They join the
    fetched pages as citable evidence and count as verified evidence.
    """
    clean_name = " ".join(company_name.split())
    if not clean_name:
        raise HermesError("company name is empty")
    run_search = search_fn or web_search
    run_fetch = fetch_fn or fetch_page
    try:
        planned_queries = plan_search_queries(clean_name, provider)
    except Exception as error:
        raise HermesError(f"query planning failed: {error}") from error
    evidence_entries = _gather_verified_pages(
        clean_name, planned_queries, run_search, run_fetch
    )
    evidence_entries.extend(_review_evidence_entries(review_evidence))
    if not evidence_entries:
        return _insufficient_evidence_intel()
    try:
        return synthesize_intel(clean_name, evidence_entries, provider)
    except Exception as error:
        raise HermesError(f"intel synthesis failed: {error}") from error


def _gather_verified_pages(
    company_name: str,
    planned_queries: list[PlannedQuery],
    run_search: Callable[[str], list[SearchResult]],
    run_fetch: Callable[[str], str],
) -> list[EvidenceEntry]:
    """Search, fetch (review platforms first), and keep only pages that
    verify as belonging to the company."""
    tracked_results: list[tuple[SearchResult, str]] = []
    seen_urls: set[str] = set()
    for planned_query in planned_queries:
        for result in run_search(planned_query.query):
            if result.url in seen_urls:
                continue
            seen_urls.add(result.url)
            tracked_results.append((result, planned_query.track))
    # Stable sort: review-platform pages first, search order kept otherwise.
    tracked_results.sort(
        key=lambda tracked: 0 if _is_review_platform_url(tracked[0].url) else 1
    )
    evidence_entries: list[EvidenceEntry] = []
    for result, track in tracked_results:
        if len(evidence_entries) >= MAX_FETCHED_PAGES:
            break
        page_text = run_fetch(result.url)
        if not page_text.strip():
            continue
        if not page_belongs_to_company(company_name, result.title, result.url, page_text):
            continue
        evidence_entries.append(
            EvidenceEntry(
                title=result.title, url=result.url, text=page_text,
                track=track, kind="signal",
            )
        )
    return evidence_entries


def _review_evidence_entries(review_evidence: list[dict[str, str]] | None) -> list[EvidenceEntry]:
    """Convert caller-supplied review evidence into citable entries."""
    entries: list[EvidenceEntry] = []
    for review in (review_evidence or [])[:MAX_REVIEW_EVIDENCE_ITEMS]:
        review_text = str(review.get("text", "")).strip()
        if not review_text:
            continue
        review_kind = str(review.get("kind", "review")).strip()
        entries.append(
            EvidenceEntry(
                title=str(review.get("sourceTitle", "")).strip() or "Employee review",
                url=str(review.get("sourceUrl", "")).strip(),
                text=review_text[:MAX_REVIEW_EVIDENCE_CHARS],
                track="api",
                kind=review_kind if review_kind in ("review", "signal") else "review",
            )
        )
    return entries


def _insufficient_evidence_intel() -> dict:
    """The required output state when nothing could be verified as this
    company's evidence (spec §4.6.3) — no synthesis is attempted."""
    return {
        "summary": "",
        "knownFor": [],
        "notableProjects": [],
        "reputationNotes": "",
        "sentiment": "unknown",
        "evidenceStatus": "insufficient",
        "positiveItems": [],
        "negativeItems": [],
        "genericPraiseCluster": False,
    }


def _is_review_platform_url(url: str) -> bool:
    host = urllib.parse.urlparse(url).netloc.lower()
    return any(marker in host for marker in REVIEW_PLATFORM_HOST_MARKERS)


def _describe_evidence_entry(entry: EvidenceEntry) -> str:
    if entry.kind == "review":
        return "employee review"
    track_descriptions = {
        "blended": "web page, general search",
        "positive": "web page, positive-track search",
        "negative": "web page, negative-track search",
    }
    return track_descriptions.get(entry.track, "web page")


def _require_response_content(raw_response: str) -> str:
    """Return the model's response, failing loudly when it came back empty.

    A thinking model can spend its entire token budget in the reasoning
    channel and return empty content; that deserves its own error instead
    of a misleading JSON parse failure from the extractors downstream.
    """
    if not raw_response.strip():
        raise HermesError(
            "model returned no content (a thinking model may have "
            "exhausted its token budget)"
        )
    return raw_response


def _extract_track_queries(raw_response: str) -> dict[str, list[str]] | None:
    """Parse the planner's tracked object shape; None when it isn't one."""
    match = re.search(r"\{[\s\S]*\}", raw_response)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    track_keys = {
        "blended": "blendedQueries",
        "positive": "positiveQueries",
        "negative": "negativeQueries",
    }
    track_queries: dict[str, list[str]] = {}
    for track, key in track_keys.items():
        values = parsed.get(key)
        if isinstance(values, list):
            track_queries[track] = [
                value.strip() for value in values if isinstance(value, str) and value.strip()
            ]
    return track_queries or None


def _extract_json_array(raw_response: str) -> list:
    match = re.search(r"\[[\s\S]*\]", raw_response)
    if not match:
        raise HermesError("planner did not return a JSON array")
    parsed = json.loads(match.group(0))
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise HermesError("planner did not return a string array")
    return parsed


def _extract_json_object(raw_response: str) -> dict:
    # Salvage before the greedy span: decode one JSON value starting at
    # the first brace. A valid object followed by trailing prose that
    # itself contains braces parses cleanly here, while the greedy span
    # below would stretch to the LAST brace and corrupt the object.
    object_start = raw_response.find("{")
    if object_start != -1:
        try:
            salvaged_object, _end_index = json.JSONDecoder().raw_decode(
                raw_response, object_start
            )
        except json.JSONDecodeError:
            salvaged_object = None
        if isinstance(salvaged_object, dict):
            return salvaged_object
    match = re.search(r"\{[\s\S]*\}", raw_response)
    if not match:
        raise HermesError("synthesizer did not return a JSON object")
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError as decode_error:
        # Every parse failure must surface as a HermesError: the
        # synthesis retry and its stderr dump are keyed on it, and a
        # raw decode error escaping here skipped both (live failure:
        # gemma4's malformed JSON — "Expecting ',' delimiter").
        raise HermesError(
            f"synthesizer returned malformed JSON: {decode_error}"
        ) from decode_error
    if not isinstance(parsed, dict):
        raise HermesError("synthesizer did not return a JSON object")
    return parsed


def _print_unparseable_synthesis_response(raw_response: str) -> None:
    """Dump a synthesis response that was not a JSON object to stderr.

    The analyzer has no logging setup; stderr is what lands in
    `docker compose logs analyzer`, so a parse failure stays diagnosable
    instead of surfacing as a bare 502 with the model's actual reply
    lost. The text is deliberately kept OUT of the raised error, which
    propagates to the client UI.
    """
    print(
        "hermes: synthesizer did not return a JSON object; raw model "
        f"response ({len(raw_response)} characters), first "
        f"{MAX_REPORTED_RESPONSE_CHARS} characters:\n"
        f"{raw_response[:MAX_REPORTED_RESPONSE_CHARS]}",
        file=sys.stderr,
    )


def _normalize_intel(
    intel: dict, evidence_entries: list[EvidenceEntry], company_name: str
) -> dict:
    """Coerce the LLM's object into the exact intel shape; raise on garbage.

    Split items are normalized mechanically: an item whose evidenceIndex
    does not point at a real evidence entry is DROPPED (citation
    enforcement lives here, in code — not in the prompt's good will).
    """
    def string_list(value) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(item).strip() for item in value if str(item).strip()][:8]

    summary = str(intel.get("summary", "")).strip()
    reputation_notes = str(intel.get("reputationNotes", "")).strip()
    if not summary:
        raise HermesError("synthesizer returned an empty summary")
    sentiment = str(intel.get("sentiment", "unknown")).strip().lower()
    company_domain_label = _company_domain_label(company_name)
    positive_items = _normalize_items(
        intel.get("positiveItems"), evidence_entries, company_domain_label
    )
    negative_items = _normalize_items(
        intel.get("negativeItems"), evidence_entries, company_domain_label
    )
    return {
        "summary": summary,
        "knownFor": string_list(intel.get("knownFor")),
        "notableProjects": string_list(intel.get("notableProjects")),
        "reputationNotes": reputation_notes or "no notable reputation signals found",
        "sentiment": sentiment if sentiment in VALID_SENTIMENTS else "unknown",
        "evidenceStatus": "sufficient",
        "positiveItems": positive_items,
        "negativeItems": negative_items,
        "genericPraiseCluster": _has_generic_praise_cluster(positive_items),
    }


def _normalize_items(
    raw_items, evidence_entries: list[EvidenceEntry], company_domain_label: str
) -> list[dict]:
    """Normalize one section's items: enforce citations, band specificity,
    sort by (specificity, corroboration), cap at MAX_ITEMS_PER_SECTION.

    An item citing an entry on the company's own domain is also dropped:
    the company's pages are marketing, not reviews (the live AccuLynx
    case had "positive reviews" sourced from acculynx.com itself).
    """
    if not isinstance(raw_items, list):
        return []
    scored_items: list[tuple[int, int, dict]] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        claim = str(raw_item.get("claim", "")).strip()
        evidence_index = raw_item.get("evidenceIndex")
        if not claim:
            continue
        if not isinstance(evidence_index, int) or isinstance(evidence_index, bool):
            continue
        if evidence_index < 1 or evidence_index > len(evidence_entries):
            continue
        evidence_entry = evidence_entries[evidence_index - 1]
        evidence_domain_label = _registrable_domain_label(evidence_entry.url)
        if company_domain_label and evidence_domain_label == company_domain_label:
            continue
        specificity = _coerce_specificity(raw_item.get("specificity"))
        corroboration = _coerce_corroboration(raw_item.get("corroboration"))
        scored_items.append(
            (
                specificity,
                corroboration,
                {
                    "claim": claim,
                    "specificityBand": _specificity_band(specificity),
                    "corroboration": corroboration,
                    "sourceTitle": evidence_entry.title,
                    "sourceUrl": evidence_entry.url,
                    "kind": evidence_entry.kind,
                },
            )
        )
    scored_items.sort(key=lambda scored: (-scored[0], -scored[1]))
    return [item for _specificity, _corroboration, item in scored_items[:MAX_ITEMS_PER_SECTION]]


def _company_domain_label(company_name: str) -> str:
    """The company name as one domain-style label: lowercased, with the
    alphanumeric runs of its tokens concatenated ("AccuLynx" ->
    "acculynx", "OAG" -> "oag", "Oag Aviation Worldwide" ->
    "oagaviationworldwide")."""
    return "".join(re.findall(r"[a-z0-9à-ÿ]+", company_name.lower()))


def _registrable_domain_label(url: str) -> str:
    """The registrable label of a URL's host: "acculynx" for
    https://www.acculynx.com/about and https://blog.acculynx.com,
    "glassdoor" for https://www.glassdoor.ca. "" when the URL has no
    usable host. The comparison against the company label is exact —
    a label that merely CONTAINS the company name (oagreviews.com)
    is a different label and never matches."""
    host = urllib.parse.urlparse(url).netloc.lower().rsplit("@", 1)[-1].split(":")[0]
    host_labels = [label for label in host.split(".") if label]
    if len(host_labels) >= 2:
        return host_labels[-2]
    if host_labels:
        return host_labels[0]
    return ""


def _coerce_specificity(value) -> int:
    try:
        specificity = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(0, min(5, specificity))


def _coerce_corroboration(value) -> int:
    try:
        corroboration = int(float(value))
    except (TypeError, ValueError):
        return 1
    return max(1, min(10_000_000, corroboration))


def _specificity_band(specificity: int) -> str:
    """Spike rubric bands: 4-5 high, 2-3 medium, 0-1 generic."""
    if specificity >= 4:
        return "high"
    if specificity >= 2:
        return "medium"
    return "generic"


def _has_generic_praise_cluster(positive_items: list[dict]) -> bool:
    """True when the top positive items are dominated by generic-band
    claims, at least one repeated at cluster scale (spec §4.2)."""
    generic_items = [
        item for item in positive_items if item["specificityBand"] == "generic"
    ]
    if len(generic_items) < GENERIC_PRAISE_CLUSTER_MIN_GENERIC_ITEMS:
        return False
    return any(
        item["corroboration"] >= GENERIC_PRAISE_CLUSTER_MIN_CORROBORATION
        for item in generic_items
    )


def _normalize_for_matching(text: str) -> str:
    """Lowercase, punctuation to spaces, collapse whitespace (for identity matching)."""
    without_punctuation = re.sub(r"[^a-z0-9à-ÿ]+", " ", text.lower())
    return re.sub(r"\s+", " ", without_punctuation).strip()


def _contains_phrase(normalized_text: str, normalized_phrase: str) -> bool:
    """Whole-phrase containment on normalized text (no partial-word hits)."""
    if not normalized_phrase:
        return False
    pattern = rf"(?<![a-z0-9à-ÿ]){re.escape(normalized_phrase)}(?![a-z0-9à-ÿ])"
    return re.search(pattern, normalized_text) is not None


def _parse_duckduckgo_lite(page_html: str) -> list[SearchResult]:
    """Extract result title/url pairs from DuckDuckGo lite HTML.

    Result anchors look like:
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=<urlencoded>&rut=...">Title</a>
    """
    results: list[SearchResult] = []
    seen_urls: set[str] = set()
    anchor_pattern = re.compile(
        r'<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        re.IGNORECASE | re.DOTALL,
    )
    for href, raw_title in anchor_pattern.findall(page_html):
        url_match = re.search(r"uddg=([^&\"']+)", href)
        if not url_match:
            continue
        url = urllib.parse.unquote(url_match.group(1))
        if not url.startswith("http") or url in seen_urls:
            continue
        title = _html_to_text(raw_title).strip()
        if not title:
            continue
        seen_urls.add(url)
        results.append(SearchResult(title=title, url=url))
    return results


def _html_to_text(page_html: str) -> str:
    """Minimal HTML -> text: drop scripts/styles/tags, unescape, collapse space."""
    without_scripts = re.sub(
        r"<(script|style|noscript)[^>]*>[\s\S]*?</\1>", " ", page_html, flags=re.IGNORECASE
    )
    without_tags = re.sub(r"<[^>]+>", " ", without_scripts)
    unescaped = html.unescape(without_tags)
    return re.sub(r"\s+", " ", unescaped).strip()
