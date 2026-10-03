"""Hermes: deep company-intel agent (spec F8).

Agentic loop: the LLM plans a small set of web-search queries for a company
name, the agent runs them through ``web_search``, fetches the top pages
through ``fetch_page``, and the LLM synthesizes a structured intel object
from the gathered evidence.

Privacy: only the company name ever leaves the machine (as a search query).
No profile, job-seeker, or job-posting data is sent anywhere.

Politeness budgets are fixed and small: at most 4 planned queries, at most
6 fetched pages, 10s per HTTP request, ~6KB of text kept per page.
"""
from __future__ import annotations

import html
import json
import re
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from .providers.base import CompletionOptions, LlmProvider

MAX_PLANNED_QUERIES = 4
MAX_FETCHED_PAGES = 6
REQUEST_TIMEOUT_SECONDS = 10.0
MAX_PAGE_BYTES = 256 * 1024
MAX_PAGE_CHARS = 6000
MAX_EVIDENCE_CHARS = 12000
USER_AGENT = "JobRadarHermes/0.1 (local company-research agent; contact: n/a)"

VALID_SENTIMENTS = ("positive", "mixed", "negative", "unknown")


class HermesError(Exception):
    """The agent could not produce intel (network, parse, or LLM failure)."""


@dataclass
class SearchResult:
    title: str
    url: str


def plan_search_queries(company_name: str, provider: LlmProvider) -> list[str]:
    """Ask the LLM for web-search queries about the company; sanitize + cap."""
    prompt = (
        f'You are researching the company "{company_name}" for a job seeker. '
        "Propose web search queries that reveal what the company does, what it "
        "is known for, its tech stack, and its reputation (reviews, layoffs news). "
        "Reply with ONLY a JSON array of 2 to 4 query strings, e.g. "
        '["Acme Corp what do they do", "Acme Corp reviews"].'
    )
    raw_response = provider.complete(
        prompt, CompletionOptions(max_tokens=256, temperature=0.2)
    )
    queries = _extract_json_array(raw_response)
    cleaned_queries = [query.strip() for query in queries if query.strip()]
    return cleaned_queries[:MAX_PLANNED_QUERIES]


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


def synthesize_intel(
    company_name: str,
    evidence_pages: list[dict[str, str]],
    provider: LlmProvider,
) -> dict:
    """Ask the LLM to synthesize the intel object from gathered evidence."""
    if evidence_pages:
        evidence_text = "\n\n".join(
            f"[Page {page_number}] {page['title']} ({page['url']})\n{page['text']}"
            for page_number, page in enumerate(evidence_pages, start=1)
        )[:MAX_EVIDENCE_CHARS]
    else:
        evidence_text = "(no pages could be fetched; rely on general knowledge and say so)"
    prompt = (
        f'Researching the company "{company_name}". Evidence:\n\n{evidence_text}\n\n'
        "Summarize for a job seeker. Reply with ONLY a JSON object with exactly "
        'these keys: "summary" (2-3 sentences on what the company does), '
        '"knownFor" (array of short strings: products, reputation, culture), '
        '"notableProjects" (array of short strings: flagship products or projects), '
        '"reputationNotes" (2-3 sentences: reviews, layoffs, controversies, or '
        '"no notable reputation signals found"), "sentiment" (one of '
        '"positive", "mixed", "negative", "unknown").'
    )
    raw_response = provider.complete(
        prompt, CompletionOptions(max_tokens=1024, temperature=0.2)
    )
    intel = _extract_json_object(raw_response)
    return _normalize_intel(intel)


def analyze_company(
    company_name: str,
    provider: LlmProvider,
    search_fn: Callable[[str], list[SearchResult]] | None = None,
    fetch_fn: Callable[[str], str] | None = None,
) -> dict:
    """Run the full agent loop for one company. Raises HermesError on failure."""
    clean_name = " ".join(company_name.split())
    if not clean_name:
        raise HermesError("company name is empty")
    run_search = search_fn or web_search
    run_fetch = fetch_fn or fetch_page
    try:
        queries = plan_search_queries(clean_name, provider)
    except Exception as error:
        raise HermesError(f"query planning failed: {error}") from error
    evidence_pages: list[dict[str, str]] = []
    for query in queries:
        for result in run_search(query):
            if len(evidence_pages) >= MAX_FETCHED_PAGES:
                break
            page_text = run_fetch(result.url)
            if page_text.strip():
                evidence_pages.append(
                    {"title": result.title, "url": result.url, "text": page_text}
                )
        if len(evidence_pages) >= MAX_FETCHED_PAGES:
            break
    try:
        return synthesize_intel(clean_name, evidence_pages, provider)
    except Exception as error:
        raise HermesError(f"intel synthesis failed: {error}") from error


def _extract_json_array(raw_response: str) -> list:
    match = re.search(r"\[[\s\S]*\]", raw_response)
    if not match:
        raise HermesError("planner did not return a JSON array")
    parsed = json.loads(match.group(0))
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise HermesError("planner did not return a string array")
    return parsed


def _extract_json_object(raw_response: str) -> dict:
    match = re.search(r"\{[\s\S]*\}", raw_response)
    if not match:
        raise HermesError("synthesizer did not return a JSON object")
    parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise HermesError("synthesizer did not return a JSON object")
    return parsed


def _normalize_intel(intel: dict) -> dict:
    """Coerce the LLM's object into the exact intel shape; raise on garbage."""
    def string_list(value) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(item).strip() for item in value if str(item).strip()][:8]

    summary = str(intel.get("summary", "")).strip()
    reputation_notes = str(intel.get("reputationNotes", "")).strip()
    if not summary:
        raise HermesError("synthesizer returned an empty summary")
    sentiment = str(intel.get("sentiment", "unknown")).strip().lower()
    return {
        "summary": summary,
        "knownFor": string_list(intel.get("knownFor")),
        "notableProjects": string_list(intel.get("notableProjects")),
        "reputationNotes": reputation_notes or "no notable reputation signals found",
        "sentiment": sentiment if sentiment in VALID_SENTIMENTS else "unknown",
    }


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
