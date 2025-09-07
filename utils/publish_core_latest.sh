#!/usr/bin/env bash
set -e
set -x

cd "$(dirname $0)/.."

if ! command -v npm >/dev/null; then
  echo "ERROR: NPM is not found"
  exit 1
fi

if ! npm whoami >/dev/null 2>&1; then
  echo "ERROR: NPM is not logged in."
  exit 1
fi

VERSION=$(node -e 'console.log(require("./package.json").version)')
echo "==================== Publishing core packages version ${VERSION} to latest ================"

# Publish core packages to latest tag
npm publish --access=public packages/playwright-core --tag=latest
npm publish --access=public packages/playwright --tag=latest  
npm publish --access=public packages/playwright-test --tag=latest

echo "Done."