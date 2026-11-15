#!/usr/bin/env bash
set -euo pipefail

# --- 1. Robustly Load .env File ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
else
  echo "Error: .env file not found at $SCRIPT_DIR/.env" >&2
  exit 1
fi

# --- 2. Validation Helper ---
get_env_var() {
  local var_name="$1"
  local default_val="${2:-}"
  local val="${!var_name:-$default_val}"
  if [ -z "$val" ]; then
    echo "Error: Required environment variable '$var_name' is missing or empty in .env!" >&2
    exit 1
  fi
  echo "$val"
}

# --- 3. Pull Config from Environment ---
CLIENT_ID="$(get_env_var 'CLIENT_ID')"
BACKEND_URL="$(get_env_var 'BACKEND_URL')"
TOKEN_FILE="$(get_env_var 'TOKEN_FILE' '.kube/my-tunnel/session_token')"
mkdir -p "$(dirname "$TOKEN_FILE")"

SESSION_TOKEN=""
SSH_USER=""

# 1. Reuse existing session token if already authenticated and valid
if [ -f "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
  SESSION_TOKEN=$(cat "$TOKEN_FILE")
  echo "[*] Using cached application session token."
fi

# Optional: Quick health/validation check with backend to ensure it hasn't expired
# Assumes backend has an endpoint like /api/auth/verify that returns 200 OK if valid
VERIFY_RES=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$BACKEND_URL" \
  -H "Authorization: Bearer $SESSION_TOKEN" || echo "000")

if [ "$VERIFY_RES" -eq 200 ]; then
  echo "[*] Cached session token is valid."
elif [ "$VERIFY_RES" -eq 401 ] || [ "$VERIFY_RES" -eq 403 ]; then
  echo "[!] Cached session token is expired or unauthorized (HTTP $VERIFY_RES). Re-authenticating..."
  rm -f "$TOKEN_FILE"
  SESSION_TOKEN=""
else
  echo "[!] Error: Backend returned HTTP status $VERIFY_RES (Server may be down or unreachable)."
  echo "[!] Preserving cached token file. Please check your Next.js server and try again."
  exit 1
fi

# 2. Fallback: If no valid token exists (or cache failed verification), run GitHub device flow
if [ -z "$SESSION_TOKEN" ]; then
  echo "[1] Requesting device code from GitHub..."
  DEVICE_RES=$(curl -s -X POST "https://github.com/login/device/code" \
    -H "Accept: application/json" \
    -d "client_id=$CLIENT_ID" \
    -d "scope=read:user read:org")

  DEVICE_CODE=$(echo "$DEVICE_RES" | jq -r '.device_code')
  USER_CODE=$(echo "$DEVICE_RES" | jq -r '.user_code')
  VERIFY_URI=$(echo "$DEVICE_RES" | jq -r '.verification_uri')
  INTERVAL=$(echo "$DEVICE_RES" | jq -r '.interval // 5')

  echo "=========================================="
  echo "1. Opening browser to: $VERIFY_URI"
  echo "2. Your one-time code is: $USER_CODE"
  echo "=========================================="

  # Auto-open browser
  if command -v xdg-open &>/dev/null; then
    xdg-open "$VERIFY_URI" &>/dev/null || true
  elif command -v open &>/dev/null; then
    open "$VERIFY_URI" &>/dev/null || true
  fi

  echo "[2] Waiting for you to authorize in the browser..."

  GITHUB_ACCESS_TOKEN=""
  # 3. Poll GitHub until authorization is complete
  while [ -z "$GITHUB_ACCESS_TOKEN" ]; do
    sleep "$INTERVAL"
    POLL_RES=$(curl -s -X POST "https://github.com/login/oauth/access_token" \
      -H "Accept: application/json" \
      -d "client_id=$CLIENT_ID" \
      -d "device_code=$DEVICE_CODE" \
      -d "grant_type=urn:ietf:params:oauth:grant-type:device_code")

    ERROR=$(echo "$POLL_RES" | jq -r '.error // empty')
    if [ -z "$ERROR" ]; then
      GITHUB_ACCESS_TOKEN=$(echo "$POLL_RES" | jq -r '.access_token')
    elif [ "$ERROR" != "authorization_pending" ] && [ "$ERROR" != "slow_down" ]; then
      echo "Authentication failed: $ERROR"
      exit 1
    fi
  done

  echo "[3] GitHub authentication successful. Exchanging token with backend..."

  # 4. Exchange raw GitHub token with Next.js backend for a custom session_token
  EXCHANGE_RES=$(curl -s -X POST "$BACKEND_URL" \
    -H "Content-Type: application/json" \
    -d "{\"github_token\": \"$GITHUB_ACCESS_TOKEN\"}")

  SESSION_TOKEN=$(echo "$EXCHANGE_RES" | jq -r '.session_token // empty')

  if [ -z "$SESSION_TOKEN" ]; then
    echo "Error: Backend failed to issue session token: $EXCHANGE_RES" >&2
    exit 1
  fi

  echo "$SESSION_TOKEN" >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "[4] Successfully obtained and saved application session token!"
fi

# --- 5. Pass application's session token into WebSocket & SSH Tunnel ---
echo "[*] Using session token for connection..."

echo "[5] Launching SSH Tunnel over WebSocket..."

export SESSION_TOKEN
export SSH_USER
./db-connect.sh
