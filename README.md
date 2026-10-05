# JobRadar — local-first, explainable IT job search

JobRadar collects IT job postings from several job boards, checks each one
against rules you set, and scores the ones that survive — so you spend your
time on real, worthwhile openings instead of scams, ghost jobs, and
staffing-agency middlemen.

Everything runs on your own machine. Your profile, your settings, and every
job you look at stay in a local database. JobRadar is a *search* tool only:
it never applies for you, tracks your applications, or sends your data
anywhere. (One narrow exception, explained under
[Company intel](#company-intel): researching a company searches the web for
that company's name — nothing about you.)

## Quick install (install.sh)

You need **Docker** (with Compose v2) — everything else, including the
local AI server (Ollama) and its model, is set up for you.

**Linux**

```bash
./install.sh
```

The script checks your system, asks a few questions (which AI model, your
search country and keywords, an optional free Adzuna key), starts
everything, and prints the dashboard address: **http://localhost:5173**.

**Windows (via WSL2)**

1. In PowerShell (as administrator) run `wsl --install`, then reboot and
   finish setting up your Ubuntu user when it opens.
2. Install Docker Desktop for Windows and, in its settings, enable the
   WSL integration for your Ubuntu distribution.
3. Inside the **WSL Ubuntu terminal** (not PowerShell), unzip JobRadar,
   `cd` into the folder, and run `./install.sh` exactly as on Linux.

**macOS**

Install Docker Desktop for Mac, then run `./install.sh` in a terminal.
This path is expected to work but has not been tested by the maintainers.

Good to know:

- Re-running `./install.sh` is safe. It keeps your `.env` and your data,
  and doubles as the update/restart path.
- After the first install, use [`./run.sh`](#starting-and-stopping) for
  everyday starts — it just boots the app.
- Your database lives in `./data` and your settings in `./.env`. Back
  those two up and you have backed up JobRadar.

## Manual installation

If you prefer to set things up yourself:

1. Install **Docker** (with Compose v2) and **Ollama**
   (https://ollama.com/download) on your machine. JobRadar talks to the
   Ollama running on your machine, not a container.
2. Get the code and enter the folder:

   ```bash
   git clone https://github.com/developurror/Job-Radar.git
   cd Job-Radar
   ```

3. Create your settings file and point it at your Ollama:

   ```bash
   cp .env.example .env
   ```

   In `.env`, set:

   ```bash
   OLLAMA_BASE_URL=http://host.docker.internal:11434
   LLM_MODEL=hermes3:8b        # or any other Ollama model you like
   ```

4. Download the AI model:

   ```bash
   ollama pull hermes3:8b      # use the model you set in LLM_MODEL
   ```

5. Build and start the services (this deliberately skips the optional
   `llm` container — your own Ollama does that job):

   ```bash
   docker compose up -d --build --no-deps analyzer api client bot
   ```

6. Open the dashboard: **http://localhost:5173**

The three services, if you ever need them directly:

- Dashboard: http://localhost:5173
- API: http://localhost:3001 (health check at `/health`)
- Analyzer (the AI/embeddings service): http://localhost:8000 (health
  check at `/health`, interactive API docs at `/docs`)

*Advanced alternative:* the compose file also ships an `llm` service that
runs Ollama inside Docker. It needs an NVIDIA GPU and the
`nvidia-container-toolkit` on the host, and it does not work under Docker
Desktop on Windows. The setup above — Ollama on your machine — is the one
that works everywhere, so prefer it unless you know you need the
container.

### Development

Live reload with source files bind-mounted:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Tests (they mock the AI models — no weights are downloaded):

```bash
cd api && npm test
cd analyzer && python -m pytest tests/ -v
cd client && npm run typecheck && npm run build
```

## What it does, and how to use it

### Search the web

The **Search the web** panel at the top of the dashboard is how jobs get
in. Set your keywords, country, province/state, city, and field, tick the
sources you want, and click **Run search**. A banner then reports, per
source, how many postings were fetched, how many were new, and how many
were duplicates.

| Source | Needs a key? | Notes |
|---|---|---|
| Hacker News "Who is hiring?" | No | The monthly thread, via the Algolia HN API |
| Adzuna | Yes — free key from developer.adzuna.com | Keyword + location search |
| RemoteOK | No | Public JSON API. *Data courtesy of [RemoteOK](https://remoteok.com) — please link back to RemoteOK when displaying their listings.* |
| Arbeitnow | No | Free job-board API |
| The Muse | No | Public jobs API; your Field value is used as its category |

Example: keywords `software engineer`, country `ca`, province `Quebec`,
field `software` searches Adzuna Canada for software-engineer postings
while the keyless sources bring in their remote listings.

Duplicates are filtered three ways: exact source IDs, a content
fingerprint, and a similarity check against postings from the same
company — so a job reposted under a slightly different title still counts
as one job.

Adzuna stays off until its key exists. Paste the app ID and key into the
Adzuna fields in the panel (or into `.env`) — the panel only ever shows
"saved ····last4"; the raw key is never sent back to your browser.

Which settings win, in order: what you type in the panel for this run,
then what you previously saved in the panel, then `.env`. Saving in the
panel never modifies your `.env`.

### Your profile

The **Your profile** section (left side) describes you: a free-text list
of your skills and your years of experience.

Example: skills `TypeScript, Vue 3, Node.js, PostgreSQL`, experience `7`.

Your profile drives the *interview chance* score below, so keep it
honest and current.

### Evaluation rules

This is the filter. Every posting is checked against your rules and lands
in one of three outcomes:

- **Passed** — it satisfies your rules.
- **Failed** — a required rule didn't match, or a dealbreaker did. Failed
  jobs are out.
- **Needs review** — the checks couldn't decide; a human should look.

**Criteria** come in three kinds:

- **Required** — the posting must match. Example: a *Canada* criterion so
  only Canadian jobs pass.
- **Dealbreaker** — the posting must *not* match. Example: a *No
  agencies* criterion with the patterns `recruit` and `staffing agency` —
  any posting that trips it fails on the spot.
- **Preferred** — nice to have; shown for information, never decides the
  outcome.

JobRadar ships with ready-made criteria templates (remote-only, salary
floors, regions, employment types, and more) — add one, then adjust it —
and you can also build fully custom criteria.

Each criterion is checked in up to three ways, cheapest first: a
**keyword** check (does the text contain these words?), a **meaning**
check (does the posting *mean* this, even in other words?), and an **AI
judge** that reads the posting when the first two can't decide. Checking
stops as soon as the outcome is certain, so evaluation stays fast.

**Flag detectors** are the second half of the rules. Each watches for one
kind of problem and attaches a warning to the job — they never remove a
job by themselves:

- **Scam risk** — too-good-to-be-true promises, upfront-payment requests.
- **Fake or reposted job** — the same opening recycled over and over.
- **Misleading remote** — advertised as remote, actually on-site.
- **Below-market salary** — the offered range sits under what the role
  normally pays (see *Salary benchmarks* below).
- **Toxic culture signals** — crunch and "rockstar ninja" language.
- **Illegal or dubious practices** — unpaid trials, discriminatory terms.
- **Staffing intermediary** — a recruiter or staffing agency standing
  between you and the actual employer.

Every detector can be switched off in the **Flag detectors** section if
it doesn't match what you care about.

Click **Evaluate all** to (re)run the rules over everything you've
collected.

### Scoring

Click **Score all** to grade the jobs that passed. Every job gets two
0–100 scores:

- **Interview chance** — "can *I* land an interview?" Compares the
  posting against your profile: your skills, your experience, how well
  the role matches what you've liked before.
- **Job quality** — "is this job legit and worth it?" Looks at the
  posting itself: salary, clarity, red flags, and the company's
  reputation when known.

Open any job and choose **Show details** to see the full breakdown: every
factor behind both scores, with the exact evidence that produced it —
never just a number. Example evidence from the salary factor:

> posting 85000–110000 CAD vs CA median ≈108000 for software developer
> (p25 82000, p75 138000) — within the national range

Rate jobs with the 👍 / 👎 buttons as you browse. Two things use your
ratings: the score-all run researches the companies of your best jobs
(see below), and once you have at least 20 ratings (at least 5 of each
kind) scoring adds a **Learned match** factor that favors postings
resembling the ones you rated highly. Below that threshold the factor
simply doesn't appear. Your ratings are training data that never leaves
your machine — the model is fitted on the spot, locally, each time.

**Salary benchmarks.** JobRadar bundles approximate salary bands
(p25 / median / p75) for nine role families in Canada (CAD) and the US
(USD), derived from public labor statistics (Statistics Canada / Job Bank
Canada wage reports; US Bureau of Labor Statistics OES). They are
orientation aids dated 2026, not gospel — if you want fresher numbers,
edit `api/src/data/salaryBenchmarks.json`. The comparison only happens
when the posting names a salary in the matching currency; seniority in
the title adjusts the band (junior ×0.7, senior ×1.3).

### Company intel

Open a job and look at the **Company intel** card to learn about the
employer: what the company is known for, notable projects, reputation
notes, and an overall sentiment.

Research never starts on its own. If a company hasn't been researched
yet, the card says so and offers a **Run intel** button; a researched
company has a **Refresh** button. Research means: the AI plans a few web
searches, reads the most relevant result pages, and writes up the card.
Results are cached on your machine for 30 days.

All research runs **one company at a time**, in the order requested —
including the automatic research for your top 10 companies during
**Score all**. This is deliberate: parallel AI research can exhaust a
modest machine's memory, so JobRadar queues instead. While your company
is being researched, its card shows a progress overlay; everything else
stays usable.

Cached intel also feeds scoring: a researched company's sentiment counts
toward the *job quality* score, with the intel itself cited as evidence.

> **Privacy:** company research is the one deliberate exception to
> JobRadar's local-first rule. The only thing that leaves your machine
> is the company name in a search query — never your profile, your
> ratings, or anything about you.

### Discord bot (optional)

JobRadar can also answer on Discord. On a server you control, a member
runs `/jobradar search`, answers two short rounds of questions (what
they are looking for, then filters like work mode, salary floor,
experience, and whether staffing companies are acceptable), and gets
their top matches — scored, with company intel — right in chat, best
first, with **More results** for the next pages. `/jobradar help`
explains the flow in chat.

The bot is a chat-sized front-end on the same local API; the dashboard
stays the full tool. Each Discord user searches with their own answers
— a bot search never touches your dashboard's evaluations or scores —
and their answers are remembered on your machine so the next search
starts pre-filled. `/jobradar forget` wipes a user's remembered
answers. Without a bot token the `bot` service logs one line and
idles; everything else works exactly as before.

**Set it up once:**

1. Go to the
   [Discord Developer Portal](https://discord.com/developers/applications)
   and create a **New Application** (any name, e.g. "JobRadar").
2. Open its **Bot** page and click **Reset Token**; copy the token —
   that is your `DISCORD_BOT_TOKEN`. Leave every **Privileged Gateway
   Intent** switch OFF: the bot works through slash commands only and
   never reads chat messages, so it needs none.
3. Invite the bot to your server: under **OAuth2 → URL Generator**,
   tick the `bot` and `applications.commands` scopes, then tick the
   bot permissions **Send Messages**, **Embed Links**, and **Use Slash
   Commands**. Open the generated URL and pick your server.
4. Get the server's id: in Discord, turn on **Developer Mode** (User
   Settings → Advanced), then right-click your server's icon →
   **Copy Server ID**. That is `DISCORD_GUILD_ID` — registering the
   command per-server makes it appear instantly instead of after
   Discord's global propagation delay.
5. Add both to your `.env` and restart (`./run.sh`, or
   `docker compose up -d --build --no-deps analyzer api client bot`):

   ```
   DISCORD_BOT_TOKEN=…
   DISCORD_GUILD_ID=…
   ```

   Optionally add `DISCORD_ALLOWED_ROLE_ID` (a role's id, from Server
   Settings → Roles with Developer Mode on): when set, only members
   holding that role can use `/jobradar`; when unset, the whole server
   can.

One person's search runs the same ingestion, scoring, and company
research as the dashboard — on your machine, one search at a time — so
a busy server keeps your machine busy; the role gate is the throttle.
And one honesty note, which the bot's own help text repeats: what
users type to the bot passes through Discord's servers, like any
Discord message.

### Choosing the AI backend

Local Ollama is the default (`LLM_PROVIDER=ollama` in `.env`). Two other
backends exist:

**llama.cpp on your machine** — if you already run `llama-server`:

```bash
# start it on your machine first, e.g.:
llama-server -m /path/to/model.gguf --port 8080
```

```bash
LLM_PROVIDER=llamacpp
# LLAMACPP_BASE_URL defaults to http://host.docker.internal:8080
```

**A hosted, OpenAI-compatible API** — stronger models, but less private
and usually paid:

```bash
LLM_PROVIDER=hosted
HOSTED_BASE_URL=https://<provider>/v1
HOSTED_API_KEY=<key>
LLM_MODEL=<model name>
```

You can also mix: keep `LLM_PROVIDER=ollama` for everyday checks and set
`LLM_DEEP_PROVIDER=hosted` (plus its key) so only company research — the
deep route — uses the stronger model. `LLM_DEEP_MODEL` picks a different
model for that route.

After changing `.env`, restart with `./run.sh` so the services pick the
new settings up.

### Starting and stopping

```bash
./run.sh                 # start everything (also rebuilds if code changed)
docker compose stop      # stop, keeping your data
```

To update: get the new code (for example `git pull`, or a fresh download),
then run `./install.sh` again — it keeps your `.env` and your data — or
just `./run.sh`.

## Troubleshooting

**The dashboard doesn't open / a service never answers.**
Make sure Docker is running, then look at the logs:

```bash
docker compose logs
```

Re-running `./install.sh` (or `./run.sh`) is always safe and fixes most
half-started states.

**"Port already in use" (5173, 3001, or 8000).**
Another copy of JobRadar — or another app — is holding the port. If you
have JobRadar in two folders, stop the other copy first:

```bash
docker compose stop   # run inside the other folder
```

**Scoring or evaluation fails with an error (503), or the analyzer says
the AI is unreachable.**
JobRadar refuses to guess: when a check needs the AI and the AI isn't
there, it fails loudly instead of silently producing weaker results.
Almost always this means Ollama isn't running or the model wasn't
downloaded:

```bash
ollama serve                 # if Ollama isn't running
ollama pull hermes3:8b       # the model named by LLM_MODEL in .env
```

**`could not select device driver "nvidia" with capabilities: [[gpu]]`**
You're starting the optional `llm` container, whose GPU reservation
Docker Desktop's internal VM can't satisfy. Skip that service (every
command in this README already does) and let the Ollama on your machine
do the AI work instead:

```bash
docker compose up -d --build --no-deps analyzer api client bot
```

**Adzuna never fetches anything / shows as skipped.**
It has no credentials yet. Add the free app ID and key in the **Search
the web** panel or in `.env`, then run a search again. The other five
sources need no key.

**Company research seems slow.**
It runs one company at a time on purpose, and each company takes a few
searches and page reads. The queue drains in order — a company you start
now may wait behind a few started earlier (for example by **Score
all**). Cached results open instantly.

**The first build takes forever.**
Normal — the first build downloads several GB of dependencies. Later
starts take seconds.

## License

JobRadar is free software, licensed under the **GNU Affero General Public
License v3.0 or later** (AGPL-3.0-or-later). See [LICENSE](./LICENSE) for
the full text.

In short: anyone may use, modify, and share it, but any modified version —
including one run as a network service — must stay open source under the
same license. It can never be taken closed-source.
