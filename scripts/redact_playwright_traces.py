#!/usr/bin/env python3
"""Redact credentials from Playwright diagnostics ZIP files before upload.

Playwright traces are useful failure diagnostics, but their network records can
contain request headers. This full-stack E2E sends a bearer access token and a
refresh cookie, so publishing a raw trace would publish credentials too. The
script rewrites every ZIP archive below the supplied diagnostics directory in
place, redacting credential-bearing headers and token-shaped strings while
preserving all other data for the Playwright trace viewer. Playwright can copy a
trace archive into both `test-results` and the HTML report under an opaque name,
so matching only `trace.zip` is not enough.

Only standard-library modules are used: GitHub-hosted Ubuntu runners provide
Python 3, and this keeps the failure path independent of project dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import zipfile
from pathlib import Path
from typing import Any

SENSITIVE_HEADER_NAMES = {
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
}
REDACTED = "<redacted>"
BEARER = re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+")
JWT = re.compile(r"\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b")
COOKIE_ASSIGNMENT = re.compile(
    r"(?i)\b(?:refresh_token|auth_token)\s*=\s*[^;\s\"']+",
)


def redact_string(value: str) -> str:
    """Redact credentials which might occur outside structured header fields."""
    value = BEARER.sub("Bearer " + REDACTED, value)
    value = JWT.sub(REDACTED, value)
    return COOKIE_ASSIGNMENT.sub(lambda match: match.group(0).split("=", 1)[0] + "=" + REDACTED, value)


def redact_value(value: Any) -> Any:
    """Redact credentials anywhere in a decoded trace payload.

    Playwright has used two header representations — a `{name, value}` list and
    a plain object — and stores cookies in the same two shapes. Rather than
    tracking which subtree is a header block, any key (or `{name, value}` pair)
    whose name is credential-bearing is redacted wherever it occurs. Everything
    else keeps its structure, with token-shaped text rewritten by
    `redact_string`, so the trace viewer still renders the archive.
    """
    if isinstance(value, str):
        return redact_string(value)

    if isinstance(value, list):
        return [redact_value(item) for item in value]

    if isinstance(value, dict):
        name = value.get("name")
        if isinstance(name, str) and name.lower() in SENSITIVE_HEADER_NAMES and "value" in value:
            return {key: REDACTED if key == "value" else redact_value(item) for key, item in value.items()}
        return {
            key: REDACTED if key.lower() in SENSITIVE_HEADER_NAMES else redact_value(item)
            for key, item in value.items()
        }

    return value


def redact_text(text: str) -> str:
    """Redact JSON or JSON-lines trace payloads; fall back to token regexes."""
    try:
        return json.dumps(redact_value(json.loads(text)), separators=(",", ":"), ensure_ascii=False)
    except json.JSONDecodeError:
        pass

    lines: list[str] = []
    parsed_any = False
    for line in text.splitlines(keepends=True):
        newline = "\n" if line.endswith("\n") else ""
        body = line[:-1] if newline else line
        try:
            lines.append(json.dumps(redact_value(json.loads(body)), separators=(",", ":"), ensure_ascii=False) + newline)
            parsed_any = True
        except json.JSONDecodeError:
            lines.append(redact_string(line))
    return "".join(lines) if parsed_any else redact_string(text)


def redact_archive(path: Path) -> None:
    """Atomically replace one diagnostics archive with a redacted copy."""
    with tempfile.NamedTemporaryFile(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
    ) as temporary:
        temporary_path = Path(temporary.name)

    try:
        with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(temporary_path, "w") as target:
            for info in source.infolist():
                data = source.read(info.filename)
                try:
                    data = redact_text(data.decode("utf-8")).encode("utf-8")
                except UnicodeDecodeError:
                    pass

                copied = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                copied.compress_type = info.compress_type
                copied.comment = info.comment
                copied.external_attr = info.external_attr
                copied.internal_attr = info.internal_attr
                copied.create_system = info.create_system
                target.writestr(copied, data)
        os.replace(temporary_path, path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("diagnostics_directory", type=Path, help="Playwright diagnostics directory")
    args = parser.parse_args()

    # Every archive-shaped diagnostic must be verified and rewritten. Silently
    # skipping a truncated ZIP would mark redaction successful and allow the
    # workflow to upload an uninspected file which may still contain tokens.
    # `redact_archive` opens each candidate and raises `BadZipFile` (or another
    # I/O error) before any upload when the archive is not readable.
    archives = sorted(args.diagnostics_directory.rglob("*.zip"))
    if not archives:
        print(f"No ZIP diagnostics found under {args.diagnostics_directory}")
        return

    for archive in archives:
        redact_archive(archive)
        print(f"Redacted credentials from {archive}")


if __name__ == "__main__":
    main()
