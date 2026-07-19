# Backend Version Release

[繁體中文](ZH-TW/backend-release.md) | English

The Express / Node backend on `main` uses Semantic Versioning. The application baseline merged by PR #392 is `5455d6a524c39eeafd4bfb860afb3a7c6fb8b27a` and has package version `1.0.0`. The first release tag points to the later `main` commit that adds this release automation without changing backend behavior.

## Publish a version

Publishing starts only when an annotated tag exactly matching `vX.Y.Z` is pushed. The numeric part must equal `backend/package.json`, the tag must point to the current `main` HEAD, and the same commit must have a successful main CI run containing backend build, unit, integration, E2E, and security jobs.

```bash
git switch main
git pull --ff-only origin main
git tag -a v1.0.0 -m "Near Chat backend v1.0.0"
git push origin v1.0.0
```

The workflow publishes:

- `ghcr.io/nearcsie/near-chat-backend:1.0.0`
- `ghcr.io/nearcsie/near-chat-backend:sha-<12-character-commit>`
- a provenance attestation and Traditional Chinese GitHub Release containing the exact commit and image digest

No mutable `latest` tag is published. Deploy and roll back by digest:

```bash
docker pull ghcr.io/nearcsie/near-chat-backend@sha256:<digest-from-release>
```

## Immutability and failure handling

Version and commit image references are treated as immutable. A clean first publication requires the GitHub Release and both image references to be absent. A rerun only verifies a complete existing publication whose two references resolve to the same digest and whose Release records that commit and digest.

The workflow stops for partial publications, mismatched digests, a Release without images, or images without a Release. It never overwrites or reconstructs an existing version automatically. Investigate the registry and Release manually before retrying.

The production image uses Node.js 24 and pnpm 11. Release artifacts must never contain `.env` files, credentials, database volumes or dumps containing real data, or uploaded user files.
