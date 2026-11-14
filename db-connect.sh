#!/bin/sh
set -e

ENV_FILE=".env"

# Helper function to extract a value from .env
get_env_var() {
  var_name="$1"
  if [ -f "$ENV_FILE" ]; then
    # Finds line starting with VAR_NAME=, strips quotes, and returns value
    grep -E "^${var_name}=" "$ENV_FILE" | cut -d '=' -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
  fi
}

INSTALL_DIR="${HOME}/.local/bin"
TARGET_BIN="${INSTALL_DIR}/websocat"
PID_DIR="${HOME}/.local/share"
PID_FILE="${PID_DIR}/websocat-ssh.pid"

# Target configuration
WSS_URL="$(get_env_var 'WSS_URL')"
POD_SSH_USER="$(get_env_var 'POD_SSH_USER')"
DATABASE_HOST="$(get_env_var 'DATABASE_HOST')"
DATABASE_USER="$(get_env_var 'DATABASE_USER')"
DATABASE_NAME="$(get_env_var 'DATABASE_NAME')"
DATABASE_PASSWORD="$(get_env_var 'DATABASE_PASSWORD')"
CMD="ssh -f -N -o "ConnectTimeout=15" -o "ExitOnForwardFailure=yes" -o "ServerAliveInterval=15" -o "ServerAliveCountMax=6" -o "TCPKeepAlive=yes" -o "IPQoS=throughput" -o "StrictHostKeyChecking=no" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519,rsa-sha2-512,rsa-sha2-256,ssh-rsa -o PubkeyAcceptedKeyTypes=ssh-ed25519,rsa-sha2-512,rsa-sha2-256,ssh-rsa -o ProxyCommand=\"$TARGET_BIN --binary - $WSS_URL\" -L 127.0.0.1:5433:$DATABASE_HOST:5433 -l $POD_SSH_USER -p 22 localhost"
# Base command
BASE_PSQL="psql -h 127.0.0.1 -p 5433 -U $DATABASE_USER -d $DATABASE_NAME"

# Add PGPASSWORD prefix only if password exists
if [ -n "$DATABASE_PASSWORD" ]; then
  CMD2="PGPASSWORD=\"$DATABASE_PASSWORD\" $BASE_PSQL"
else
  CMD2="$BASE_PSQL"
fi

# Ensure directories exist
mkdir -p "$INSTALL_DIR" "$PID_DIR"

# 1. Dependency Check / Installation
install_websocat() {
  if command -v websocat >/dev/null 2>&1 || [ -x "$TARGET_BIN" ]; then
    return 0
  fi

  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
  Darwin)
    case "$ARCH" in
    arm64 | aarch64) RELEASE_BIN="websocat.aarch64-apple-darwin" ;;
    x86_64) RELEASE_BIN="websocat.x86_64-apple-darwin" ;;
    *)
      echo "Unsupported architecture: $ARCH" >&2
      exit 1
      ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
    arm64 | aarch64) RELEASE_BIN="websocat.aarch64-unknown-linux-musl" ;;
    x86_64) RELEASE_BIN="websocat.x86_64-unknown-linux-musl" ;;
    *)
      echo "Unsupported Linux architecture: $ARCH" >&2
      exit 1
      ;;
    esac
    ;;
  *)
    echo "Unsupported operating system: $OS" >&2
    exit 1
    ;;
  esac

  echo "websocat binary not found."
  echo "Installing to: $TARGET_BIN ($OS/$ARCH)..."
  curl -sSL "https://github.com/vi/websocat/releases/latest/download/${RELEASE_BIN}" -o "$TARGET_BIN"
  chmod +x "$TARGET_BIN"
  echo "websocat installed to $TARGET_BIN"
}

# 1. PostgreSQL Client Dependency Check / Installation
install_psql_client() {
  if command -v psql >/dev/null 2>&1; then
    return 0
  fi

  echo "psql CLI is required but not found."
  read -p "Would you like to install the PostgreSQL client now? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Installation cancelled by user." >&2
    exit 1
  fi

  echo "Installing PostgreSQL client..."

  if [[ "$OSTYPE" == "darwin"* ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "Homebrew is required on macOS to automatically install psql." >&2
      echo "Please install Homebrew first: https://brew.sh/" >&2
      exit 1
    fi
    brew install postgresql

  elif [[ -f /etc/os-release ]]; then
    . /etc/os-release
    case "$ID" in
    ubuntu | debian | linuxmint | pop)
      sudo apt-get update && sudo apt-get install -y postgresql-client
      ;;
    fedora | rhel | centos | rocky | almalinux)
      sudo dnf install -y postgresql
      ;;
    *)
      echo "Unsupported Linux distribution: $ID" >&2
      echo "Please install the PostgreSQL client package manually for your system." >&2
      exit 1
      ;;
    esac
  else
    echo "Could not detect operating system package manager." >&2
    exit 1
  fi

  echo "psql client successfully installed."
}

# 2. Get active PID
get_tunnel_pid() {
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE")"
    if kill -0 "$PID" 2>/dev/null; then
      echo "$PID"
      return 0
    fi
  fi
  pgrep -f "websocat.*$WSS_URL" 2>/dev/null || true
}

# 3. Start Tunnel using $CMD
start_tunnel() {
  RUNNING_PID="$(get_tunnel_pid)"
  if [ -n "$RUNNING_PID" ]; then
    echo "Tunnel is ALREADY running (PID: $RUNNING_PID)"
    return 0
  fi

  echo "Starting SSH Tunnel using \$CMD..."

  # Execute $CMD string safely with eval
  eval "$CMD"

  # Capture PID of the newly spawned background process
  sleep 1
  NEW_PID="$(pgrep -f "websocat.*$WSS_URL" | head -n 1)"
  if [ -n "$NEW_PID" ]; then
    echo "$NEW_PID" >"$PID_FILE"
    echo "SSH Tunnel started! (PID: $NEW_PID)"
  else
    echo "Tunnel started, but could not retrieve PID."
  fi
}

# 4. Stop Tunnel
stop_tunnel() {
  RUNNING_PID="$(get_tunnel_pid)"
  if [ -z "$RUNNING_PID" ]; then
    echo "No active SSH tunnel found."
    rm -f "$PID_FILE"
    return 0
  fi

  echo "Stopping SSH Tunnel (PID: $RUNNING_PID)..."
  kill "$RUNNING_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "SSH Tunnel stopped successfully."
}

# ------------------------------------------------------------------
# Execution & Interactive Menu
# ------------------------------------------------------------------
install_websocat

RUNNING_PID="$(get_tunnel_pid)"

echo ""
echo "=========================================="
echo "    WebSocket SSH Tunnel Manager"
echo "=========================================="
if [ -n "$RUNNING_PID" ]; then
  echo " Status: 🟢 ACTIVE (PID: $RUNNING_PID)"
else
  echo " Status: 🔴 INACTIVE"
fi
echo "------------------------------------------"
echo "  1) Start SSH Tunnel"
echo "  2) Stop / Kill Active Tunnel"

# Only show Option 3 if the tunnel is currently running
if [ -n "$RUNNING_PID" ]; then
  echo "  3) Connect to PostgreSQL (psql CLI)"
  echo "  4) Exit"
  PROMPT_RANGE="1-4"
else
  echo "  3) Exit"
  PROMPT_RANGE="1-3"
fi

echo "=========================================="
printf "Choose an option [%s]: " "$PROMPT_RANGE"

if [ -t 0 ]; then
  read -r CHOICE
else
  read -r CHOICE </dev/tty
fi

# Handle choice based on tunnel state
if [ -z "$RUNNING_PID" ]; then
  case "$CHOICE" in
  1) start_tunnel ;;
  2) stop_tunnel ;;
  3)
    echo "Exiting."
    exit 0
    ;;
  *)
    echo "Invalid option."
    exit 1
    ;;
  esac
else
  case "$CHOICE" in
  1) start_tunnel ;;
  2) stop_tunnel ;;
  3)
    install_psql_client
    echo "Connecting to PostgreSQL database..."
    eval "$CMD2"
    ;;
  4)
    echo "Exiting."
    exit 0
    ;;
  *)
    echo "Invalid option."
    exit 1
    ;;
  esac
fi
