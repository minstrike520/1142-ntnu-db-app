#!/usr/bin/env bash
# ENVIRONMENT setup script for Claude Code on the web.
#
# IMPORTANT: paste this content into the cloud environment's "Setup script"
# field in the UI. It runs as ROOT, BEFORE the repository is checked out, so it
# MUST NOT reference repo files (backend/, frontend/, package.json). Anything
# repo-dependent (pnpm install, migrations) belongs in the SessionStart hook:
#   .claude/hooks/cloud-session-setup.sh
#
# Ubuntu 24.04 base already ships openssl and Node, so NO apt is needed. This
# also avoids the 403 failures from the base image's pre-existing PPAs
# (deadsnakes / ondrej-php on ppa.launchpadcontent.net, which is not allowlisted).
#
# Network access: the default "Trusted" level already allows npm, GitHub, Node,
# and Docker Hub - no custom domains are required.
set -eu

# Activate pnpm globally so the binary is captured in the environment cache
# snapshot (fetched from registry.npmjs.org, which Trusted allows).
corepack enable && corepack prepare pnpm@latest --activate

# Pre-pull the test DB image so it is cached in the snapshot. The container
# itself is started per-session by the SessionStart hook, because running
# containers do not persist in the cache (only on-disk files do).
docker pull postgres:16 || true

echo "Environment setup complete."
