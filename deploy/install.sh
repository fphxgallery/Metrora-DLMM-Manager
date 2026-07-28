#!/usr/bin/env bash
# DLMM Manager production install for systemd on Linux.
# Run as root: sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/dlmm-manager
SERVICE=dlmm-manager
USER_NAME=dlmm
NODE_MAJOR_REQUIRED=22

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash deploy/install.sh" >&2
  exit 1
fi

# Resolve the repo root from this script's own location so the install works no
# matter which directory it was invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

echo "==> Installing DLMM Manager to ${APP_DIR} (from ${REPO_ROOT})"

if command -v apt-get >/dev/null 2>&1; then PKG=apt
elif command -v dnf >/dev/null 2>&1; then PKG=dnf
elif command -v yum >/dev/null 2>&1; then PKG=yum
else PKG=""; fi

node_ok() {
  command -v node >/dev/null 2>&1 &&
    [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "${NODE_MAJOR_REQUIRED}" ]
}

echo "==> Installing base packages (git, curl)"
case "$PKG" in
  apt) export DEBIAN_FRONTEND=noninteractive; apt-get update -y; apt-get install -y ca-certificates curl gnupg git ;;
  dnf) dnf install -y ca-certificates curl gnupg2 git ;;
  yum) yum install -y ca-certificates curl gnupg2 git ;;
  "")  echo "!! No supported package manager (apt/dnf/yum). Install git, curl and Node ${NODE_MAJOR_REQUIRED}+ manually, then re-run." >&2; exit 1 ;;
esac

if node_ok; then
  echo "==> Node $(node -v) already present"
else
  echo "==> Installing Node.js ${NODE_MAJOR_REQUIRED} (NodeSource)"
  case "$PKG" in
    apt) curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" | bash -; apt-get install -y nodejs ;;
    dnf) curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" | bash -; dnf install -y nodejs ;;
    yum) curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" | bash -; yum install -y nodejs ;;
  esac
fi

if ! node_ok; then
  echo "Node ${NODE_MAJOR_REQUIRED}+ required, found $(command -v node >/dev/null 2>&1 && node -v || echo 'none') — install aborted." >&2
  exit 1
fi
echo "==> Using Node $(node -v), npm $(npm -v)"

# Service user (no login, no home).
if ! id "${USER_NAME}" >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin "${USER_NAME}"
fi

# Full clean copy every time. A plain `cp -r` onto an existing tree only adds and
# overwrites — it never deletes files removed from the repo, so a stale source
# file can linger and break the build. tsc has the same blind spot for dist/.
mkdir -p "${APP_DIR}"
rm -rf "${APP_DIR}/src" "${APP_DIR}/client" "${APP_DIR}/dist"
cp -r package.json package-lock.json tsconfig.json src client "${APP_DIR}/"
# The client is rebuilt from source below; never copy a host-built node_modules,
# whose rollup native binary would be for the wrong platform.
rm -rf "${APP_DIR}/client/node_modules" "${APP_DIR}/client/dist"
cd "${APP_DIR}"

echo "==> Installing dependencies + building"
npm ci
# `npm install` (not ci) for the client: a lockfile generated on macOS pins
# @rollup/rollup-darwin-* and fails on linux.
( cd client && npm install && npm run build )
npm run build:server
npm prune --omit=dev

mkdir -p "${APP_DIR}/data"

# .env: keep an existing one, else seed from the example (must be edited).
if [ ! -f "${APP_DIR}/.env" ]; then
  if [ -f "${REPO_ROOT}/.env" ]; then
    cp "${REPO_ROOT}/.env" "${APP_DIR}/.env"
  else
    cp "${REPO_ROOT}/.env.example" "${APP_DIR}/.env"
    echo "!! Seeded ${APP_DIR}/.env from example — EDIT IT before starting (RPC endpoint at minimum)."
  fi
fi
chmod 600 "${APP_DIR}/.env"

# Control endpoints are UNAUTHENTICATED without a token, which is unsafe the
# moment the dashboard is reachable off-loopback. Generate one if absent; never
# overwrite an existing value.
if ! grep -qE '^API_TOKEN=.+' "${APP_DIR}/.env"; then
  TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 40)"
  if grep -qE '^API_TOKEN=' "${APP_DIR}/.env"; then
    sed -i "s|^API_TOKEN=.*|API_TOKEN=${TOKEN}|" "${APP_DIR}/.env"
  else
    printf '\nAPI_TOKEN=%s\n' "${TOKEN}" >> "${APP_DIR}/.env"
  fi
  echo "!! Generated API_TOKEN — SAVE THIS, it authenticates the dashboard:"
  echo "     ${TOKEN}"
fi

mkdir -p "${APP_DIR}/secrets"
chmod 700 "${APP_DIR}/secrets"

# KEYPAIR_PATH must be absolute and inside a writable dir: under the hardened
# unit (ProtectSystem=strict) only data/, .env and secrets/ are writable, so a
# relative default lands in the read-only app dir and fails with EROFS on import.
KP_CUR="$(grep -E '^KEYPAIR_PATH=' "${APP_DIR}/.env" | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | xargs || true)"
case "${KP_CUR}" in
  /*) : ;; # already absolute — trust the operator
  *)
    if grep -qE '^KEYPAIR_PATH=' "${APP_DIR}/.env"; then
      sed -i "s|^KEYPAIR_PATH=.*|KEYPAIR_PATH=${APP_DIR}/secrets/keypair.json|" "${APP_DIR}/.env"
    else
      printf '\nKEYPAIR_PATH=%s\n' "${APP_DIR}/secrets/keypair.json" >> "${APP_DIR}/.env"
    fi
    echo "==> KEYPAIR_PATH set to ${APP_DIR}/secrets/keypair.json (writable under the hardened unit)"
    ;;
esac

chown -R "${USER_NAME}:${USER_NAME}" "${APP_DIR}"

echo "==> Installing systemd unit"
cp "${REPO_ROOT}/deploy/${SERVICE}.service" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "${SERVICE}"

echo
echo "Done. Next:"
echo "  1. sudoedit ${APP_DIR}/.env   # set RPC_ENDPOINT; keep DRY_RUN=true to start"
echo "     (API_TOKEN was auto-generated above — save it; optionally set TELEGRAM_* for alerts)"
echo "  2. (live) place a keypair at the path in .env, owned by ${USER_NAME}, chmod 600"
echo "     or: sudo -u ${USER_NAME} node ${APP_DIR}/dist/wallet/index.js create"
echo "  3. sudo systemctl start ${SERVICE}"
echo "  4. journalctl -u ${SERVICE} -f"
