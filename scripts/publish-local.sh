#!/usr/bin/env bash
set -euo pipefail

REGISTRY="http://localhost:4873"

# Create a unique Verdaccio user to get a fresh token
USER="ci-$(date +%s)"
PASS="local"

TOKEN=$(curl -sf -XPUT \
  -H "Content-type: application/json" \
  -d "{\"name\":\"$USER\",\"password\":\"$PASS\"}" \
  "$REGISTRY/-/user/org.couchdb.user:$USER" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

if [ -z "$TOKEN" ]; then
  echo "Error: could not get auth token from Verdaccio at $REGISTRY" >&2
  echo "Is Verdaccio running? (docker compose up -d verdaccio)" >&2
  exit 1
fi

AUTH="--registry $REGISTRY --//localhost:4873/:_authToken=$TOKEN"

PACKAGES=(packages/core packages/mastra)

# Resolve workspace:* references to actual versions before publishing.
# Build a map of package name → version from all workspace packages.
declare -A VERSIONS
for pkg in "${PACKAGES[@]}"; do
  name=$(cd "$pkg" && node -p "require('./package.json').name")
  ver=$(cd "$pkg" && node -p "require('./package.json').version")
  VERSIONS[$name]=$ver
done

for pkg in "${PACKAGES[@]}"; do
  PKG_NAME=$(cd "$pkg" && node -p "require('./package.json').name")

  # Delete existing version from Verdaccio
  curl -sf -XDELETE \
    -H "Authorization: Bearer $TOKEN" \
    "$REGISTRY/$PKG_NAME/-rev/whatever" 2>/dev/null || true

  # Replace workspace:* with actual version in a temp copy of package.json
  cp "$pkg/package.json" "$pkg/package.json.bak"
  for dep_name in "${!VERSIONS[@]}"; do
    dep_ver="${VERSIONS[$dep_name]}"
    # Replace "workspace:*" or "workspace:^" with the resolved version
    sed -i '' "s|\"$dep_name\": \"workspace:\*\"|\"$dep_name\": \"$dep_ver\"|g" "$pkg/package.json"
    sed -i '' "s|\"$dep_name\": \"workspace:\^\"|\"$dep_name\": \"^$dep_ver\"|g" "$pkg/package.json"
  done

  echo "Publishing $pkg ($PKG_NAME@${VERSIONS[$PKG_NAME]}) to $REGISTRY..."
  (cd "$pkg" && npm publish $AUTH)

  # Restore original package.json
  mv "$pkg/package.json.bak" "$pkg/package.json"
done

echo "✅ Adapters published to $REGISTRY"
