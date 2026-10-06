#!/usr/bin/env bash
#
# JobRadar — one-shot installer.
#
# What this does:
#   1. Checks that Docker (with Compose v2) and curl are available.
#   2. Asks a few setup questions and writes a local .env file
#      (skipped on re-runs — your existing settings are kept).
#   3. Makes sure Ollama is installed on this machine and downloads
#      the AI model JobRadar uses.
#   4. Builds and starts the JobRadar services with Docker Compose.
#   5. Waits until everything answers, then offers to open the
#      dashboard in your browser.
#
# Supported: Linux, and Windows via WSL2 (run this inside your WSL
# Ubuntu). macOS with Docker Desktop is expected to work but untested.
# Re-running this script is safe: it doubles as the update/restart path.
#
# JobRadar is local-first: everything runs on this machine. The only
# downloads are Docker images, the Ollama installer/model, and (later,
# when you use it) the company research you explicitly start.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [!] %s\n' "$*"; }
fail() {
  printf '\n[x] %s\n' "$*" >&2
  printf '    If you are stuck, re-running this script is safe — it keeps your settings and data.\n' >&2
  exit 1
}

# ask "Question" "default" -> prints the answer on stdout.
ask() {
  local question="$1" default_value="$2" answer=""
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$question" "$default_value" >&2
  else
    printf '%s: ' "$question" >&2
  fi
  read -r answer || answer=""
  if [ -z "$answer" ]; then
    answer="$default_value"
  fi
  printf '%s' "$answer"
}

# confirm "Question" -> returns 0 for yes (default), 1 for no.
confirm() {
  local question="$1" answer=""
  printf '%s [Y/n]: ' "$question" >&2
  read -r answer || answer=""
  case "$answer" in
    n|N|no|No|NO) return 1 ;;
    *) return 0 ;;
  esac
}

http_status() {
  # Prints the HTTP status code for a URL, or 000 when unreachable.
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null || printf '000'
}

DASHBOARD_URL='http://localhost:5173'

# open_dashboard -> opens the dashboard in the default browser, best effort.
# Never fails the script: when no opener exists it simply prints the URL.
# JOBRADAR_NO_BROWSER=1 skips the opening (e.g. repeated test runs).
open_dashboard() {
  say "  Dashboard: $DASHBOARD_URL"
  if [ "${JOBRADAR_NO_BROWSER:-}" = '1' ]; then
    return 0
  fi
  if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi 'microsoft' /proc/version 2>/dev/null; then
    if command -v wslview >/dev/null 2>&1; then
      wslview "$DASHBOARD_URL" >/dev/null 2>&1 || true
    elif command -v cmd.exe >/dev/null 2>&1; then
      cmd.exe /c start "$DASHBOARD_URL" >/dev/null 2>&1 || true
    fi
  elif [ "$(uname -s)" = 'Darwin' ]; then
    open "$DASHBOARD_URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$DASHBOARD_URL" >/dev/null 2>&1 || true
  fi
}

say '=============================================='
say '  JobRadar installer'
say '  A local-first job search dashboard.'
say '  Everything runs on this machine.'
say '=============================================='

# ---------------------------------------------------------------- platform
step 'Checking your system'

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Linux)
    if grep -qi 'microsoft' /proc/version 2>/dev/null; then
      ok 'Windows Subsystem for Linux (WSL) detected — good, this is a supported setup.'
    else
      ok 'Linux detected.'
    fi
    ;;
  Darwin)
    warn 'macOS detected. This setup is expected to work with Docker Desktop but is untested.'
    ;;
  MINGW*|MSYS*|CYGWIN*)
    fail 'This looks like a Windows shell outside WSL. JobRadar on Windows runs inside WSL2: install WSL (wsl --install in PowerShell), then run this script from your WSL Ubuntu terminal. See the README "Quick install" section.'
    ;;
  *)
    warn "Unrecognized system '$OS_NAME' — continuing anyway."
    ;;
esac

# ---------------------------------------------------------------- prereqs
step 'Checking prerequisites'

if ! command -v docker >/dev/null 2>&1; then
  fail 'Docker was not found. Install Docker first: on Linux use https://docs.docker.com/engine/install/ (or Docker Desktop); on Windows, install Docker Desktop and enable its WSL integration. Then run this script again.'
fi
ok 'Docker found.'

if ! docker compose version >/dev/null 2>&1; then
  fail 'Docker Compose v2 was not found (the "docker compose" command). Please update Docker / Docker Desktop and run this script again.'
fi
ok 'Docker Compose v2 found.'

if ! docker info >/dev/null 2>&1; then
  fail 'Docker is installed but not running (or your user lacks permission). Start Docker Desktop, or on Linux run: sudo systemctl start docker — and if you get a permission error, log out and back in after installing Docker. Then run this script again.'
fi
ok 'Docker is running.'

if ! command -v curl >/dev/null 2>&1; then
  fail 'curl was not found. Install it (e.g. sudo apt install curl) and run this script again.'
fi
ok 'curl found.'

if command -v nvidia-smi >/dev/null 2>&1; then
  ok 'NVIDIA GPU detected — the AI model will run on the GPU.'
else
  warn 'No NVIDIA GPU detected — the AI model will run on the CPU. This works, but scoring and company research will be slower.'
fi

# ---------------------------------------------------------------- .env wizard
step 'Setup questions'

MODEL_NAME=''
if [ -f .env ]; then
  ok 'Found an existing .env — keeping your current settings.'
  MODEL_NAME="$(grep -E '^LLM_MODEL=' .env | tail -n 1 | cut -d '=' -f 2- | tr -d '"' || true)"
  if [ -z "$MODEL_NAME" ]; then
    MODEL_NAME='hermes3:8b'
  fi
else
  say '  A few questions write your local settings file (.env).'
  say '  Pressing Enter accepts the [default]. Nothing here leaves this machine.'
  say ''
  MODEL_NAME="$(ask 'Which AI model should JobRadar use? (any Ollama model, e.g. hermes3:8b, qwen2.5:7b, llama3.1:8b)' 'hermes3:8b')"
  SEARCH_COUNTRY="$(ask 'Country code for job searches (used by the Adzuna source)' 'us')"
  SEARCH_KEYWORDS="$(ask 'Job search keywords' 'software engineer')"
  say ''
  say '  Adzuna is the one source that needs a free API key'
  say '  (developer.adzuna.com). JobRadar works without it — five other'
  say '  sources need no key. Press Enter twice to skip.'
  ADZUNA_ID="$(ask 'Adzuna app ID (optional)' '')"
  ADZUNA_KEY="$(ask 'Adzuna app key (optional)' '')"
  if { [ -n "$ADZUNA_ID" ] && [ -z "$ADZUNA_KEY" ]; } || { [ -z "$ADZUNA_ID" ] && [ -n "$ADZUNA_KEY" ]; }; then
    warn 'Only one of the two Adzuna values was given — Adzuna needs both, so it will stay off until you add the other in .env or the dashboard.'
  fi
  say ''
  say '  Optional: an OpenWeb Ninja API key (openwebninja.com, free tier)'
  say '  lets company intel pull real Glassdoor employee reviews when you'
  say '  tick "(use search api)" on a research run. JobRadar works fully'
  say '  without it. Press Enter to skip.'
  OPENWEB_NINJA_KEY="$(ask 'OpenWeb Ninja API key (optional)' '')"

  cat > .env <<EOF
# JobRadar local settings — written by install.sh. Edit freely.
# Values saved in the dashboard override these defaults; this file is
# never modified by the app.

# The AI runs locally through Ollama on this machine.
LLM_PROVIDER=ollama
LLM_MODEL=$MODEL_NAME
OLLAMA_BASE_URL=http://host.docker.internal:11434

# Adzuna source (optional; the other sources need no key).
ADZUNA_APP_ID=$ADZUNA_ID
ADZUNA_APP_KEY=$ADZUNA_KEY
ADZUNA_COUNTRY=$SEARCH_COUNTRY
ADZUNA_WHAT=$SEARCH_KEYWORDS
ADZUNA_MAX_PAGES=2

# OpenWeb Ninja Glassdoor API (optional; intel precision boost, off by
# default — used only for runs where you tick "(use search api)").
OPENWEB_NINJA_API_KEY=$OPENWEB_NINJA_KEY
EOF
  ok '.env written.'
fi
say "  Model: $MODEL_NAME"

# ---------------------------------------------------------------- ollama
step 'Setting up Ollama (the local AI server)'

if ! command -v ollama >/dev/null 2>&1; then
  if confirm 'Ollama is not installed. Install it now (official installer from ollama.com)?'; then
    curl -fsSL https://ollama.com/install.sh | sh \
      || fail 'The Ollama installer failed. Install Ollama manually from https://ollama.com/download and run this script again.'
    ok 'Ollama installed.'
  else
    fail 'JobRadar needs Ollama running on this machine. Install it from https://ollama.com/download and run this script again.'
  fi
else
  ok 'Ollama found.'
fi

if ! ollama list >/dev/null 2>&1; then
  say '  Starting the Ollama server…'
  (ollama serve >/tmp/jobradar-ollama.log 2>&1 &)
  SERVER_WAIT=0
  until ollama list >/dev/null 2>&1 || [ "$SERVER_WAIT" -ge 20 ]; do
    sleep 1
    SERVER_WAIT=$((SERVER_WAIT + 1))
  done
fi
if ! ollama list >/dev/null 2>&1; then
  fail 'Ollama is installed but its server did not start. Try running "ollama serve" in another terminal, leave it running, and run this script again.'
fi
ok 'Ollama server is up.'

step "Downloading the AI model ($MODEL_NAME)"
say '  This is a few GB and can take a while on a slow connection.'
ollama pull "$MODEL_NAME" \
  || fail "Could not download the model '$MODEL_NAME'. Check the name (see https://ollama.com/library) and your connection, then run this script again."
ok "Model '$MODEL_NAME' ready."

# ---------------------------------------------------------------- services
step 'Building and starting JobRadar'
mkdir -p data
say '  The first build downloads several GB of dependencies and can take'
say '  10 minutes or more. Later runs are fast.'
docker compose up -d --build --no-deps analyzer api client bot \
  || fail 'Docker Compose failed to build or start the services. Scroll up for the Docker error; common causes are low disk space or a blocked download. Running this script again is safe.'
ok 'Services started.'

step 'Waiting for JobRadar to answer'
ANALYZER_UP=''
API_UP=''
CLIENT_UP=''
WAITED=0
while [ "$WAITED" -lt 180 ]; do
  if [ -z "$ANALYZER_UP" ] && [ "$(http_status http://localhost:8000/health)" != '000' ]; then
    ANALYZER_UP='yes'
    ok 'Analyzer is up.'
  fi
  if [ -z "$API_UP" ] && [ "$(http_status http://localhost:3001/health)" = '200' ]; then
    API_UP='yes'
    ok 'API is up.'
  fi
  if [ -z "$CLIENT_UP" ] && [ "$(http_status http://localhost:5173/)" = '200' ]; then
    CLIENT_UP='yes'
    ok 'Dashboard is up.'
  fi
  if [ -n "$ANALYZER_UP" ] && [ -n "$API_UP" ] && [ -n "$CLIENT_UP" ]; then
    break
  fi
  sleep 3
  WAITED=$((WAITED + 3))
done

if [ -z "$ANALYZER_UP" ] || [ -z "$API_UP" ] || [ -z "$CLIENT_UP" ]; then
  fail 'The services started but did not all answer in time. Check their logs with: docker compose logs — then run this script again.'
fi

# ---------------------------------------------------------------- done
say ''
say '=============================================='
say '  JobRadar is ready:  http://localhost:5173'
say '=============================================='
say ''
say '  First steps in the dashboard:'
say '    1. "Search the web" (top panel): pick your sources and Run search.'
say '    2. Set up "Your profile" and the Evaluation rules (left side).'
say '    3. "Evaluate all", then "Score all" — and browse your results.'
say ''
say '  Good to know:'
say '    - Your database lives in ./data and your settings in ./.env —'
say '      back those up and you have backed up JobRadar.'
say '    - Stop JobRadar:   docker compose stop'
say '    - Start it again:  docker compose up -d --no-deps analyzer api client bot'
say '      (or just run this script again — it also handles updates).'
say ''

# A double-clicked terminal closes the moment this script ends, taking the
# summary above with it — so offer to open the dashboard, then wait for
# Enter before finishing. Interactive runs only: piped or automated runs
# must never block waiting for input that will not come.
if [ -t 0 ]; then
  if confirm 'Open JobRadar in your browser now?'; then
    open_dashboard
  fi
  printf 'Press Enter to close this window…' >&2
  read -r press_enter || true
  say ''
fi
