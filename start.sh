#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8080}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-5000}"
UI_URL="${UI_URL:-http://127.0.0.1:${FRONTEND_PORT}}"
API_URL="${VITE_API_BASE:-http://${BACKEND_HOST}:${BACKEND_PORT}}"
FRONTEND_AUTH_ENABLED="${VITE_AUTH_ENABLED:-${AUTH_ENABLED:-false}}"
OPEN_UI="${OPEN_UI:-true}"

BACKEND_PID=""
FRONTEND_PID=""
BACKEND_PGID=""
FRONTEND_PGID=""
CLEANED_UP="false"
USE_SETSID="false"

stop_service() {
  local pid="$1"
  local label="$2"
  local pgid="${3:-}"

  if [[ -z "$pid" ]] && [[ -z "$pgid" ]]; then
    return 0
  fi

  echo "Stopping $label..."

  if [[ -n "$pgid" ]]; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
  fi

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill_child_tree "$pid" TERM
    kill -TERM "$pid" 2>/dev/null || true
  fi

  for _ in $(seq 1 20); do
    if ! service_alive "$pid" "$pgid"; then
      return 0
    fi
    sleep 0.2
  done

  echo "$label did not stop cleanly; forcing it down."
  if [[ -n "$pgid" ]]; then
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill_child_tree "$pid" KILL
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

service_alive() {
  local pid="$1"
  local pgid="${2:-}"

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  if [[ -n "$pgid" ]] && kill -0 -- "-$pgid" 2>/dev/null; then
    return 0
  fi
  return 1
}

kill_child_tree() {
  local pid="$1"
  local signal="$2"
  local child

  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi

  while read -r child; do
    [[ -z "$child" ]] && continue
    kill_child_tree "$child" "$signal"
    kill "-$signal" "$child" 2>/dev/null || true
  done < <(pgrep -P "$pid" 2>/dev/null || true)
}

cleanup() {
  if [[ "$CLEANED_UP" == "true" ]]; then
    return 0
  fi
  CLEANED_UP="true"

  echo
  echo "Stopping MOM services..."
  stop_service "$FRONTEND_PID" "Frontend" "$FRONTEND_PGID"
  stop_service "$BACKEND_PID" "Backend" "$BACKEND_PGID"
  wait_for_port_free "$BACKEND_HOST" "$BACKEND_PORT" "Backend" || true
  wait_for_port_free "127.0.0.1" "$FRONTEND_PORT" "Frontend" || true
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-60}"

  for _ in $(seq 1 "$attempts"); do
    if "$PYTHON_BIN" - "$url" >/dev/null 2>&1 <<'PY'
import sys
import urllib.request

try:
    urllib.request.urlopen(sys.argv[1], timeout=1)
except Exception:
    raise SystemExit(1)
PY
    then
      echo "$label is ready: $url"
      return 0
    fi
    sleep 1
  done

  echo "$label did not become ready in time: $url"
  return 1
}

ensure_port_free() {
  local host="$1"
  local port="$2"
  local label="$3"
  local probe_host="$host"

  if [[ "$probe_host" == "0.0.0.0" ]]; then
    probe_host="127.0.0.1"
  fi

  if "$PYTHON_BIN" - "$probe_host" "$port" >/dev/null 2>&1 <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(0.5)
    raise SystemExit(0 if sock.connect_ex((host, port)) == 0 else 1)
PY
  then
    echo "$label port is already in use: ${host}:${port}"
    echo "Stop the existing service, or choose another port:"
    echo "  BACKEND_PORT=8081 FRONTEND_PORT=5001 ./start.sh"
    exit 1
  fi
}

wait_for_port_free() {
  local host="$1"
  local port="$2"
  local label="$3"
  local probe_host="$host"

  if [[ "$probe_host" == "0.0.0.0" ]]; then
    probe_host="127.0.0.1"
  fi

  for _ in $(seq 1 20); do
    if ! "$PYTHON_BIN" - "$probe_host" "$port" >/dev/null 2>&1 <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(0.2)
    raise SystemExit(0 if sock.connect_ex((host, port)) == 0 else 1)
PY
    then
      return 0
    fi
    sleep 0.2
  done

  echo "$label port is still in use: ${host}:${port}"
  return 1
}

open_ui() {
  if [[ "$OPEN_UI" != "true" ]]; then
    echo "UI auto-open disabled. Open this URL manually: $UI_URL"
    return 0
  fi

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$UI_URL" >/dev/null 2>&1 &
  elif command -v gio >/dev/null 2>&1; then
    gio open "$UI_URL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then
    open "$UI_URL" >/dev/null 2>&1 &
  else
    echo "Could not find a browser opener. Open this URL manually: $UI_URL"
    return 0
  fi

  echo "Opened UI: $UI_URL"
}

trap cleanup EXIT INT TERM

if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
else
  require_command python3
  PYTHON_BIN="$(command -v python3)"
fi

require_command npm

if command -v setsid >/dev/null 2>&1; then
  USE_SETSID="true"
fi

if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  echo "frontend/node_modules is missing. Run: cd frontend && npm install"
  exit 1
fi

ensure_port_free "$BACKEND_HOST" "$BACKEND_PORT" "Backend"
ensure_port_free "127.0.0.1" "$FRONTEND_PORT" "Frontend"

echo "Starting MOM backend on http://${BACKEND_HOST}:${BACKEND_PORT}"
if [[ "$USE_SETSID" == "true" ]]; then
  setsid "$PYTHON_BIN" -m uvicorn backend.app.main:app \
    --reload \
    --host "$BACKEND_HOST" \
    --port "$BACKEND_PORT" &
else
  "$PYTHON_BIN" -m uvicorn backend.app.main:app \
    --reload \
    --host "$BACKEND_HOST" \
    --port "$BACKEND_PORT" &
fi
BACKEND_PID="$!"
if [[ "$USE_SETSID" == "true" ]]; then
  BACKEND_PGID="$BACKEND_PID"
else
  BACKEND_PGID=""
fi

wait_for_url "http://${BACKEND_HOST}:${BACKEND_PORT}/api/health" "Backend"

echo "Starting MOM frontend on http://127.0.0.1:${FRONTEND_PORT}"
if [[ "$USE_SETSID" == "true" ]]; then
  setsid env VITE_API_BASE="$API_URL" VITE_AUTH_ENABLED="$FRONTEND_AUTH_ENABLED" npm --prefix frontend run dev -- \
    --host "$FRONTEND_HOST" \
    --port "$FRONTEND_PORT" \
    --strictPort &
else
  VITE_API_BASE="$API_URL" VITE_AUTH_ENABLED="$FRONTEND_AUTH_ENABLED" npm --prefix frontend run dev -- \
    --host "$FRONTEND_HOST" \
    --port "$FRONTEND_PORT" \
    --strictPort &
fi
FRONTEND_PID="$!"
if [[ "$USE_SETSID" == "true" ]]; then
  FRONTEND_PGID="$FRONTEND_PID"
else
  FRONTEND_PGID=""
fi

wait_for_url "$UI_URL" "Frontend"
open_ui

echo
echo "MOM is running."
echo "Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "Frontend: $UI_URL"
echo "Auth:     ${FRONTEND_AUTH_ENABLED}"
echo "Press Ctrl+C to stop both services."

wait "$BACKEND_PID" "$FRONTEND_PID"
