#!/bin/bash
# L1.9 — vendor the gateway-export validator from floe-monorepo into
# src/gateway/vendor/: the SAME code the API's POST /ext-gateway/validate runs,
# bundled with the built-in templates, plus the contract's JSON Schema exactly
# as GET /v1/ext-gateway/contract/:version serves it.
#
#   FLOE_MONOREPO=../floe-monorepo scripts/sync-gateway-validator.sh
#
# test/gateway-vendor.test.ts fails when the vendored copy differs from a fresh
# build of the monorepo it is pointed at. Re-run this after a contract change.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
mono="$(cd "${FLOE_MONOREPO:-$here/../floe-monorepo}" && pwd)"
out="$here/src/gateway/vendor"
mkdir -p "$out"
(cd "$mono" && pnpm --filter @floe/api build:gateway-validator "$out")
echo "vendored from $mono @ $(git -C "$mono" rev-parse --short HEAD)"
