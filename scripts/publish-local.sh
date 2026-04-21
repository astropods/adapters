#!/usr/bin/env bash
set -euo pipefail

REGISTRY="http://localhost:4873"

# --- Resolve the latest @astropods/messaging version from Verdaccio ---
MSG_VERSION=$(curl -sf "$REGISTRY/@astropods%2fmessaging" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['dist-tags']['latest'])")

if [ -z "$MSG_VERSION" ]; then
  echo "Error: could not resolve @astropods/messaging version from $REGISTRY" >&2
  echo "Run 'moon run messaging:publish-local' first." >&2
  exit 1
fi
echo "Resolved @astropods/messaging@$MSG_VERSION from Verdaccio"

# --- Clear bun caches so we get the fresh tarball ---
rm -rf "$HOME/.bun/install/cache/@astropods" \
       packages/core/node_modules/@astropods \
       packages/mastra/node_modules/@astropods \
       node_modules/@astropods \
       bun.lock

# --- Patch package.json files to pin the resolved version ---
PACKAGES=(packages/core packages/mastra)
for pkg in "${PACKAGES[@]}"; do
  cp "$pkg/package.json" "$pkg/package.json.bak"
  cd "$pkg"
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
    for (const section of ['dependencies','devDependencies','peerDependencies']) {
      if (pkg[section] && pkg[section]['@astropods/messaging']) {
        pkg[section]['@astropods/messaging'] = '$MSG_VERSION';
      }
    }
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  cd - > /dev/null
done

# --- Install from Verdaccio and build ---
BUN_CONFIG_REGISTRY="$REGISTRY" bun install
bun x lerna run build

# --- Restore package.json files before publishing ---
for pkg in "${PACKAGES[@]}"; do
  mv "$pkg/package.json.bak" "$pkg/package.json"
done

# --- Publish to Verdaccio ---
USER="ci-$(date +%s)"
PASS="local"

TOKEN=$(curl -sf -XPUT \
  -H "Content-type: application/json" \
  -d "{\"name\":\"$USER\",\"password\":\"$PASS\"}" \
  "$REGISTRY/-/user/org.couchdb.user:$USER" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

if [ -z "$TOKEN" ]; then
  echo "Error: could not get auth token from Verdaccio at $REGISTRY" >&2
  exit 1
fi

AUTH="--registry $REGISTRY --//localhost:4873/:_authToken=$TOKEN"

for pkg in "${PACKAGES[@]}"; do
  PKG_NAME=$(cd "$pkg" && node -p "require('./package.json').name")
  PKG_VERSION=$(cd "$pkg" && node -p "require('./package.json').version")

  npm unpublish "$PKG_NAME@$PKG_VERSION" $AUTH --force 2>/dev/null || true

  cp "$pkg/package.json" "$pkg/package.json.bak"

  cd "$pkg"
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
    delete pkg.publishConfig;
    for (const s of ['dependencies','devDependencies','peerDependencies']) {
      if (!pkg[s]) continue;
      for (const [k,v] of Object.entries(pkg[s])) {
        if (typeof v === 'string' && v.startsWith('workspace:')) pkg[s][k] = '*';
      }
    }
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  npm publish $AUTH
  cd - > /dev/null

  mv "$pkg/package.json.bak" "$pkg/package.json"
  echo "✅ $PKG_NAME@$PKG_VERSION published to $REGISTRY"
done
