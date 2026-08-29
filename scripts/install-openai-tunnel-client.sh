#!/bin/bash
set -euo pipefail

VERSION="${LOCAL_DEV_MCP_TUNNEL_CLIENT_VERSION:-latest}"
INSTALL_ROOT="${LOCAL_DEV_MCP_TUNNEL_CLIENT_INSTALL_ROOT:-$HOME/.local-dev-mcp/tunnel-client}"
BIN_DIR="${LOCAL_DEV_MCP_TUNNEL_CLIENT_BIN_DIR:-$HOME/.local-dev-mcp/bin}"
REPO="https://github.com/openai/tunnel-client"

command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "unzip is required." >&2; exit 1; }

if [ "$VERSION" = "latest" ]; then
  LATEST_URL="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$REPO/releases/latest")"
  VERSION="${LATEST_URL##*/}"
  if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9._-]+)?$ ]]; then
    echo "[tunnel-client] Could not resolve latest release version." >&2
    exit 1
  fi
fi

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) echo "Unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=amd64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="tunnel-client-${VERSION}-${OS}-${ARCH}.zip"
BASE_URL="$REPO/releases/download/$VERSION"
TARGET_DIR="$INSTALL_ROOT/$VERSION"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/local-dev-mcp-tunnel-client.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[tunnel-client] Downloading $ASSET" >&2
curl -fsSL "$BASE_URL/$ASSET" -o "$TMP_DIR/$ASSET"
curl -fsSL "$BASE_URL/SHA256SUMS.txt" -o "$TMP_DIR/SHA256SUMS.txt"

EXPECTED="$(awk -v asset="$ASSET" '$2 == asset || $2 == "*" asset { print $1; exit }' "$TMP_DIR/SHA256SUMS.txt")"
if [ -z "$EXPECTED" ]; then
  echo "[tunnel-client] SHA256SUMS.txt does not contain $ASSET" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP_DIR/$ASSET" | awk '{print $1}')"
else
  echo "[tunnel-client] shasum or sha256sum is required." >&2
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "[tunnel-client] Checksum mismatch for $ASSET" >&2
  exit 1
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR" "$BIN_DIR"
unzip -q "$TMP_DIR/$ASSET" -d "$TARGET_DIR"
if [ ! -x "$TARGET_DIR/tunnel-client" ]; then
  chmod +x "$TARGET_DIR/tunnel-client" 2>/dev/null || true
fi
if [ ! -x "$TARGET_DIR/tunnel-client" ]; then
  echo "[tunnel-client] Archive did not contain an executable tunnel-client." >&2
  exit 1
fi

ln -sfn "$TARGET_DIR/tunnel-client" "$BIN_DIR/tunnel-client"

INSTALLED_VERSION="$($BIN_DIR/tunnel-client --version)"
echo "[tunnel-client] Installed: $INSTALLED_VERSION" >&2
echo "$BIN_DIR/tunnel-client"
