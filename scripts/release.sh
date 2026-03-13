#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [patch|minor|major]
# Defaults to patch if no argument given.
#
# What it does:
#   1. Bumps version in all package.json files
#   2. Builds the package (esbuild bundle + copies binaries)
#   3. Type-checks
#   4. Commits and tags
#   5. Pushes to GitHub
#   6. Prints npm publish command

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: ./scripts/release.sh [patch|minor|major]"
  exit 1
fi

# Get current version from root package.json
CURRENT=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT"

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "New version: $NEW_VERSION"

# Update all package.json files
for f in package.json packages/dynafetch/package.json packages/dynafetch-core/package.json; do
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$f', 'utf8'));
    pkg.version = '$NEW_VERSION';
    fs.writeFileSync('$f', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  Updated $f → $NEW_VERSION"
done

# Build
echo "Building package..."
node packages/dynafetch/build.mjs

# Type check
echo "Running type check..."
npx tsc --noEmit

# Git commit, tag, push
git add -A
git commit -m "v$NEW_VERSION"
git tag "v$NEW_VERSION"
git push origin main --tags

echo ""
echo "Pushed v$NEW_VERSION to GitHub."
echo ""
echo "To publish to npm, run:"
echo "  cd packages/dynafetch && npm publish --access public"
echo ""
echo "If you haven't logged in yet:"
echo "  npm login"
