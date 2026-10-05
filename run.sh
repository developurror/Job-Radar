#!/usr/bin/env bash
#
# JobRadar — everyday launcher.
#
# Starts everything JobRadar needs, in one command:
#   1. Checks Docker is available and running.
#   2. If JobRadar is set to use Ollama (the default), makes sure the
#      Ollama server on this machine is running and has the model.
#   3. Builds (if needed) and starts the services with Docker Compose.
#   4. Waits until everything answers, then opens the dashboard in
#      your browser (JOBRADAR_NO_BROWSER=1 prints the URL only).
#
# This script asks no questions and installs nothing. For first-time
# setup — or to change your settings — run ./install.sh instead; it
# keeps your existing .env and data when re-run.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [!] %s\n' "$*"; }
fail() {
  printf '\n[x] %s\n' "$*" >&2
  printf '    First-time setup (or a settings change) is handled by ./install.sh — it keeps your settings and data.\n' >&2
  exit 1
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

# env_value KEY DEFAULT -> the value of KEY in ./.env, or DEFAULT.
env_value() {
  local key="$1" default_value="$2" value=""
  value="$(grep -E "^${key}=" .env 2>/dev/null | tail -n 1 | cut -d '=' -f 2- | tr -d '"' || true)"
  if [ -z "$value" ]; then
    value="$default_value"
  fi
  printf '%s' "$value"
}

say '=============================================='
say '  JobRadar launcher'
say '=============================================='

# ---------------------------------------------------------------- checks
step 'Checking your system'

if ! command -v docker >/dev/null 2>&1; then
  fail 'Docker was not found. Run ./install.sh for the full setup guide.'
fi
if ! docker compose version >/dev/null 2>&1; then
  fail 'Docker Compose v2 was not found (the "docker compose" command). Run ./install.sh for the full setup guide.'
fi
if ! docker info >/dev/null 2>&1; then
  fail 'Docker is installed but not running. Start Docker (or Docker Desktop), then run this script again.'
fi
ok 'Docker is running.'

if ! command -v curl >/dev/null 2>&1; then
  fail 'curl was not found. Install it (e.g. sudo apt install curl), then run this script again.'
fi

if [ ! -f .env ]; then
  fail 'No .env settings file found. Run ./install.sh first — it creates one and asks the setup questions.'
fi
ok 'Settings file (.env) found.'

LLM_PROVIDER_NAME="$(env_value 'LLM_PROVIDER' 'ollama')"
LLM_MODEL_NAME="$(env_value 'LLM_MODEL' 'hermes3:8b')"

# ---------------------------------------------------------------- ollama
if [ "$LLM_PROVIDER_NAME" = 'ollama' ]; then
  step 'Checking Ollama (the local AI server)'

  if ! command -v ollama >/dev/null 2>&1; then
    warn 'Ollama is not installed, so the AI features (AI-judged criteria, company research) will not work.'
    warn 'JobRadar will still start. Run ./install.sh to set Ollama up.'
  else
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
      warn 'The Ollama server did not start. JobRadar will start anyway; AI features will report the AI as unreachable until Ollama runs.'
    else
      ok 'Ollama server is up.'
      if ! ollama list 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -qx "$LLM_MODEL_NAME"; then
        step "Downloading the AI model ($LLM_MODEL_NAME)"
        say '  First-time download — a few GB, can take a while on a slow connection.'
        if ollama pull "$LLM_MODEL_NAME"; then
          ok "Model '$LLM_MODEL_NAME' ready."
        else
          warn "Could not download the model '$LLM_MODEL_NAME'. JobRadar will start; AI features need this model (check the name in .env, then run: ollama pull $LLM_MODEL_NAME)."
        fi
      else
        ok "Model '$LLM_MODEL_NAME' is downloaded."
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- services
step 'Starting JobRadar'
mkdir -p data
docker compose up -d --build --no-deps analyzer api client bot \
  || fail 'Docker Compose failed to build or start the services. Scroll up for the Docker error; running ./install.sh again is safe and often fixes half-started states.'
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
say '  Stop JobRadar:  docker compose stop'
say ''
open_dashboard
say ''
