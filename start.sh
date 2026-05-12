#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
UI_URL="${UI_URL:-http://127.0.0.1:${FRONTEND_PORT}}"
API_URL="${VITE_API_BASE:-http://${BACKEND_HOST}:${BACKEND_PORT}}"
OPEN_UI="${OPEN_UI:-true}"

BACKEND_PID=""
FRONTEND_PID=""
CLEANED_UP="false"
USE_SETSID="false"

stop_service() {
  local pid="$1"
  local label="$2"

  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  if [[ "$USE_SETSID" == "true" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      echo "$label did not stop cleanly; forcing it down."
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  if [[ "$CLEANED_UP" == "true" ]]; then
    return 0
  fi
  CLEANED_UP="true"

  echo
  echo "Stopping MOM services..."
  stop_service "$FRONTEND_PID" "Frontend"
  stop_service "$BACKEND_PID" "Backend"
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
    echo "  BACKEND_PORT=8001 FRONTEND_PORT=5174 ./start.sh"
    exit 1
  fi
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

wait_for_url "http://${BACKEND_HOST}:${BACKEND_PORT}/api/health" "Backend"

echo "Starting MOM frontend on http://127.0.0.1:${FRONTEND_PORT}"
if [[ "$USE_SETSID" == "true" ]]; then
  setsid env VITE_API_BASE="$API_URL" npm --prefix frontend run dev -- \
    --host "$FRONTEND_HOST" \
    --port "$FRONTEND_PORT" \
    --strictPort &
else
  VITE_API_BASE="$API_URL" npm --prefix frontend run dev -- \
    --host "$FRONTEND_HOST" \
    --port "$FRONTEND_PORT" \
    --strictPort &
fi
FRONTEND_PID="$!"

wait_for_url "$UI_URL" "Frontend"
open_ui

echo
echo "MOM is running."
echo "Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "Frontend: $UI_URL"
echo "Press Ctrl+C to stop both services."

wait "$BACKEND_PID" "$FRONTEND_PID"
