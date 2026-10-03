# JobRadar — local-first, explainable IT job search

Phase 6 (sources, salary benchmarks, learned match, ingestion panel) is the
current state; the sections below are organized by feature area and note the
phase that introduced each.

Phase 2 adds the **criteria engine** (spec F3): a criteria table with 10
premade templates, a three-validator cascade (keyword → semantic → LLM judge),
and persisted per-job evaluations. The **client** service (Vue 3 + Vuetify +
Pinia) provides the dashboard: a left criteria rail (grouped templates, custom
criteria builder, kind/validator badges, active toggle) and a center results
list with outcome filtering, evaluate-all, outcome chips, top reasons, and
expandable per-criterion evidence.

Phase 1 added the **api** service (Node/Express/TypeScript/Drizzle/SQLite): it
ingests job postings from **Adzuna** and the monthly Hacker News "Who is
hiring?" thread, normalizes them (salary/location/employment parsing, SHA-256
fingerprinting), and dedupes — exact `(source, external_id)` and fingerprint
matches plus embedding cosine-similarity (0.92 threshold, same-company only)
via the analyzer. SQLite lives in `./data/app.db`, bind-mounted for inspection.

Phase 0 scaffolds the **analyzer** service: a Python/FastAPI "brain" with a
configurable LLM provider abstraction (local Ollama, host llama.cpp, or hosted API),
sentence-transformers embeddings, and the first two endpoints from the spec
(`GET /health`, `POST /v1/embed`).

Phase 6 widens ingestion to six sources and makes it dashboard-driven: an
**Ingestion panel** in the left rail holds your search preferences (keywords,
country, province/state, city, field), per-source toggles, and per-source
credentials — all stored in the local database, overriding the `.env`
defaults — plus a **Run ingestion** button that reports per-source counts.
It also adds **salary benchmarks** (bundled CA/US labor-statistics tables
compared against each posting's range in the score breakdown and the
below-market flag) and a **learned-match** interview-chance factor that
trains a small logistic-regression model on your local thumbs up/down
ratings once enough labels exist.

Spec: `../goals/jobradar-it-job-search-engine/files/jobradar-spec-v0.1.md`
(working title "JobRadar" — rename freely).

## Install (one-shot)

The easy path. You need Docker (with Compose v2) — everything else,
including the local AI server (Ollama) and its model, is set up for you.

**Linux**

```bash
./install.sh
```

The script checks your system, asks a few questions (AI model, search
country/keywords, an optional free Adzuna key), starts everything, and
prints the dashboard address: http://localhost:5173. Re-running it is
safe — it keeps your `.env` and your data, and doubles as the
update/restart path.

**Windows (via WSL2)**

1. In PowerShell (as administrator): `wsl --install`, then reboot and
   finish setting up your Ubuntu user when it opens.
2. Install Docker Desktop for Windows and, in its settings, enable the
   WSL integration for your Ubuntu distribution.
3. Inside the **WSL Ubuntu terminal** (not PowerShell), unzip JobRadar,
   `cd` into the folder, and run `./install.sh` exactly as on Linux.

**macOS**

Install Docker Desktop for Mac, then run `./install.sh` in a terminal.
This path is expected to work but has not been tested by the maintainers.

Notes: the installer runs the AI through an Ollama installed on your
machine (not the `llm` container described below), because that is the
setup that works across the widest range of hardware. Your database
lives in `./data` and your settings in `./.env` — back those two up and
you have backed up JobRadar.

## Prerequisites

- Docker with Compose v2
- For GPU acceleration of the `llm` service: `nvidia-container-toolkit` on the host.
  Without it, remove the `deploy.resources.reservations.devices` block from
  `docker-compose.yml` to run Ollama on CPU.

## Pull the LLM model (required, explicit step)

Ollama ships without models. After the containers are up:

```bash
docker compose exec llm ollama pull hermes3:8b
```

(`LLM_MODEL` in `.env` controls which model the analyzer requests.)

## Run

```bash
cp .env.example .env   # optional; defaults work out of the box
docker compose up --build
```

- Analyzer: http://localhost:8000 (`/health`, `/v1/embed`, `/v1/generate`, interactive docs at `/docs`)
- API: http://localhost:3001 (`/health`, `POST /v1/ingest`, `GET /v1/jobs`, `GET /v1/ingestion-runs`, criteria + evaluation endpoints below)
- Client: http://localhost:5173 (dashboard: criteria builder + results list)
- Development (live reload, source bind-mounted):
  `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`

## Ingesting jobs

**Sources (Phase 6):**

| Source | Auth | Notes |
|---|---|---|
| Hacker News "Who is hiring?" | none | Monthly thread via the Algolia HN API |
| Adzuna | free app_id/app_key (developer.adzuna.com) | Keyword + location search |
| RemoteOK | none | Public JSON API. *Data courtesy of [RemoteOK](https://remoteok.com) — please link back to RemoteOK when displaying their listings.* |
| Arbeitnow | none | Free job-board API |
| The Muse | none | Public jobs API; your Field value is passed as its category |
| We Work Remotely | none | Programming-jobs RSS feed |

All six are toggled independently; the four newer sources need no keys.
Adzuna is skipped automatically until credentials exist.

**The Ingestion panel (dashboard left rail)** is the primary way to ingest:
set keywords / country / province / city / field, tick the sources, paste
any source credentials into that source's fields, **Save config**, then
**Run ingestion** — the banner reports fetched / new / duplicates per
source. Everything you save lives in your local SQLite database
(`ingestion_config` and `source_credentials` tables) and never leaves the
machine; credentials have the same trust level as your `.env` file and are
never returned by the API (the panel only ever sees "saved ····last4").

**Configuration precedence:** a Run-ingestion request's own values win over
the saved panel config, which wins over `.env` defaults
(`ADZUNA_WHAT` / `ADZUNA_COUNTRY` / `ADZUNA_WHERE` / `ADZUNA_APP_ID` /
`ADZUNA_APP_KEY`). Saving in the panel does not modify your `.env`.

```bash
# Current config + sources with masked credential state (never raw values):
curl http://localhost:3001/v1/ingestion/config

# Save preferences / a credential:
curl -X PUT http://localhost:3001/v1/ingestion/config -H 'Content-Type: application/json' \
  -d '{"keywords":"software engineer","country":"ca","enabledSources":["hackernews","adzuna","remoteok"],
       "credentials":{"adzuna":{"app_id":"...","app_key":"..."}}}'

# Run ingestion with the saved config (or pass the same preference fields as one-off overrides):
curl -X POST http://localhost:3001/v1/ingestion/run -H 'Content-Type: application/json' -d '{}'

# The Phase 1 curl path still works (HN by default; Adzuna joins when credentials exist):
curl -X POST http://localhost:3001/v1/ingest -H 'Content-Type: application/json' -d '{}'

# Browse results:
curl http://localhost:3001/v1/jobs?limit=20
```

## Choosing the LLM backend

**Local Ollama (default)** — private, free:

```bash
LLM_PROVIDER=ollama
```

**llama.cpp on the Docker host** — for the machine that already runs `llama-server`.
Start it on the host first, e.g.:

```bash
llama-server -m /path/to/model.gguf --port 8080
```

then:

```bash
LLM_PROVIDER=llamacpp
# LLAMACPP_BASE_URL defaults to http://host.docker.internal:8080,
# which the compose file maps to the host via host-gateway.
```

**Hosted API** — stronger models, less private, usage cost:

```bash
LLM_PROVIDER=hosted
HOSTED_BASE_URL=https://<provider>/v1
HOSTED_API_KEY=<key>
LLM_MODEL=<model name>
```

**Smart routing:** leave `LLM_PROVIDER=ollama` and set `LLM_DEEP_PROVIDER=hosted`
(+ key) to triage locally for free while deep company analysis uses the hosted model.
`LLM_DEEP_MODEL` optionally picks a different model for the deep route.

**Networking note:** the analyzer's HTTP client ignores ambient proxy environment
variables (`trust_env=False`). Its backends are infrastructure you control — local
Ollama, host llama.cpp, or an explicitly configured endpoint — and a system-wide
proxy would only reroute or break those calls.

## Criteria engine (Phase 2)

```bash
# List the 10 premade templates (grouped: work mode, salary, location, domain, employment type)
curl http://localhost:3001/v1/criteria/templates

# Add a template (kind/validator/config editable in the dialog)
curl -X POST http://localhost:3001/v1/criteria -H 'Content-Type: application/json' \
  -d '{"templateId":"remote-only","kind":"required"}'

# Or a fully custom criterion
curl -X POST http://localhost:3001/v1/criteria -H 'Content-Type: application/json' \
  -d '{"name":"No agencies","kind":"dealbreaker","validator":"keyword",
       "config":{"patterns":["recruit","staffing agency"],"match":"any","target":"description"}}'

# Evaluate one job / all jobs (persisted to job_evaluations)
curl -X POST http://localhost:3001/v1/jobs/1/evaluate
curl -X POST http://localhost:3001/v1/evaluate-all -H 'Content-Type: application/json' -d '{"limit":200}'

# Filter results by outcome
curl "http://localhost:3001/v1/jobs?outcome=passed&limit=20"
curl "http://localhost:3001/v1/jobs?outcome=needs_review&limit=20"
```

Cascade order is **keyword → semantic → LLM judge**. A failed `required`
criterion or a passed `dealbreaker` knocks the job out immediately (expensive
validators are skipped). `uncertain` never knocks out — the job lands in
`needs_review`. `preferred` criteria are informational only. Semantic
statements are embedded once at criterion creation (cached in config); the
analyzer must be reachable for that and for any `llm_judge` evaluation —
otherwise the API returns a clear 503, no silent degradation.

## Scoring & flags (Phase 3)

```bash
# Score one job / all jobs (scores + flags persisted)
curl -X POST http://localhost:3001/v1/jobs/1/score
curl -X POST http://localhost:3001/v1/score-all -H 'Content-Type: application/json' -d '{"limit":200}'

# Top scores first, and hide anything carrying a flag
curl "http://localhost:3001/v1/jobs?sort=top&limit=20"
curl "http://localhost:3001/v1/jobs?hide_flagged=1&limit=20"

# Thumbs feedback (up / down / null to clear), stored locally
curl -X PUT http://localhost:3001/v1/jobs/1/feedback -H 'Content-Type: application/json' -d '{"feedback":"up"}'

# Your profile (drives interview-chance scoring), stored locally
curl http://localhost:3001/v1/profile
curl -X PATCH http://localhost:3001/v1/profile -H 'Content-Type: application/json' \
  -d '{"skillsText":"TypeScript, Vue, Postgres","yearsExperience":7}'

# Flag detectors: list config, enable/disable one
curl http://localhost:3001/v1/flags/config
curl -X PATCH http://localhost:3001/v1/flags/config -H 'Content-Type: application/json' \
  -d '{"type":"staffing_intermediary","enabled":false}'
```

Two 0–100 scores per job: **interview chance** ("can *I* land an interview?",
profile-driven) and **job quality** ("is this job legit and worth it?"),
combined 55/45. Every score ships a per-factor breakdown with exact evidence;
missing data narrows the breakdown instead of penalizing. Flags
(`scam_risk`, `fake_repost`, `remote_misleading`, `salary_below_market`,
`toxic_culture`, `illegal_practice`, `staffing_intermediary`) run a
keyword → semantic → LLM cascade and are all warning severity (plus an
informational note for undisclosed salary) — they inform, never auto-reject.

Scoring needs the analyzer for embeddings only when your profile has skills
text or an analyzer-capable flag is enabled; otherwise it runs fully offline.
When the analyzer *is* needed but unreachable, scoring fails loudly (503).

**Salary benchmarks (Phase 6).** A bundled table
(`api/src/data/salaryBenchmarks.json`) holds approximate annual p25 / median /
p75 bands for nine role families in Canada (CAD) and the US (USD), derived
from public labor statistics (Statistics Canada / Job Bank Canada wage
reports; US Bureau of Labor Statistics OES). They are **orientation-only
approximations dated 2026** — edit the JSON to refresh them. When a posting
discloses a salary, its country is detected, and the currency matches, the
salary factor's evidence shows the comparison ("posting 85000–110000 CAD vs
CA median ≈108000 for software developer (p25 82000, p75 138000) — within the
national range"), and the `salary_below_market` flag fires with that evidence
when the whole range sits below the benchmark p25 (the older flat-floor check
remains as fallback when no benchmark applies). Seniority in the title scales
the band (junior ×0.7, senior ×1.3).

**Learned match (Phase 6).** Your thumbs up/down ratings are training labels.
Once you have at least 20 ratings with at least 5 of each kind, scoring adds
a **Learned match** factor (weight 0.15) to interview chance: the analyzer
embeds your labeled postings and the ones being scored, fits a logistic
regression on the spot (nothing is stored or sent anywhere), and reports how
much each posting resembles the ones you rated highly. Its evidence cites
your label counts ("learned from 24 of your ratings (12 👍 / 12 👎); …").
Below the threshold the factor is simply absent — scores behave exactly as
before.

## Company intel (Phase 4–5)

The API's Hermes agent researches companies on demand: it asks the LLM for
search queries, runs up to 4 web searches, reads up to 6 result pages, and
synthesizes `{summary, knownFor, notableProjects, reputationNotes,
sentiment}`. The result is cached locally per company for 30 days and shown
as a "Company intel" card (sentiment badge, known-for chips, notable
projects, research date).

Research never starts on its own. Opening a job only reads the cache; a
company with no cached intel shows "No company intel has been run yet." with
a **Run intel** button, and a cached company has a **Refresh** button that
enqueues a re-run. Score-all also enqueues research for the top 10 companies
among jobs that passed the cascade. All research — button or score-all —
runs through a single FIFO queue in the API, one company at a time: stacked
Hermes runs exhausted a test machine's RAM during Phase 4 acceptance, so the
app serializes them itself instead of depending on host LLM settings. While
a run is active, other job cards can't be expanded, and the open detail
panel shows a spinner under a grey overlay until its company's research
finishes.

Cached intel feeds the **company reputation** quality factor (weight 0.2):
positive/mixed/negative sentiment scores 0.85/0.55/0.25; with no cached intel
the factor stays informational and existing scores are unchanged.

**Privacy note:** web search is a deliberate, narrow exception to JobRadar's
local-first rule. The only thing that leaves your machine is the company
name in a search query — no profile data, no job history, nothing else. All
intel is cached locally; nothing is reported anywhere.

```bash
# Cached intel for a company (read-only; status: fresh|stale|none|queued|researching|failed)
curl http://localhost:3001/v1/companies/Acme%20Corp/intel
# Enqueue research for a company (202; drains one at a time through the queue)
curl -X POST http://localhost:3001/v1/companies/Acme%20Corp/research
# Queue snapshot: which company is researching now, which are waiting
curl http://localhost:3001/v1/companies/research-state
```

## Tests

```bash
cd api && npm test          # vitest: ingestion + config + criteria + scoring + benchmarks + learned match + company intel (164 tests)
cd analyzer && python -m pytest tests/ -v   # 32 tests
cd client && npm run typecheck && npm run build
```

Tests mock the embedding model and LLM — no weights are downloaded.

## Troubleshooting

**`could not select device driver "nvidia" with capabilities: [[gpu]]`** —
the `desktop-linux` daemon runs inside Docker Desktop's VM, which cannot see
the host NVIDIA driver, so the `llm` service's GPU reservation fails. Fallback:
skip the `llm` service entirely. Phase 1 doesn't need it (embeddings run on
CPU in the analyzer; point `OLLAMA_BASE_URL` at a host Ollama if you want the
LLM route, e.g. `http://host.docker.internal:11434`):

```bash
docker compose up --build --no-deps analyzer api
```

**Manual smoke test** (after the stack is up, no LLM required):

```bash
# Analyzer alive? (triage_reachable reflects your Ollama/LLM setup)
curl http://localhost:8000/health
# API alive? ("analyzer": true means the api can reach the analyzer)
curl http://localhost:3001/health
# Run an ingestion (HN "Who is hiring?"; Adzuna joins in when credentials exist)
curl -X POST http://localhost:3001/v1/ingest -H 'Content-Type: application/json' -d '{}'
# Inspect results
curl "http://localhost:3001/v1/jobs?limit=20"
curl http://localhost:3001/v1/ingestion-runs
```

## What's NOT built yet (post-MVP)

- LinkedIn / Glassdoor sources (login walls + bot detection; deliberately deferred)

## License

JobRadar is free software, licensed under the **GNU Affero General Public
License v3.0 or later** (AGPL-3.0-or-later). See [LICENSE](./LICENSE) for the
full text.

In short: anyone may use, modify, and share it, but any modified version —
including one run as a network service — must stay open source under the same
license. It can never be taken closed-source.
