#!/usr/bin/env python3
"""
SEDS Pakistan website environment validator (zero-dependency, Python 3 stdlib).

Reads .env.local from the repo root (if present) and overlays actual process
environment variables (environment takes precedence). Prints a per-key status
report and a summary. This is a REPORT, not a gate: it always exits 0 and
never fails a build.

Never prints secret values: only key names, statuses, and value sources.

Usage:
    python3 scripts/validate_env.py [--check] [--env-file PATH] [--repo-path PATH]
"""

import argparse
import os
import sys
from pathlib import Path

# Server-side secrets required for full production functionality.
REQUIRED_KEYS = [
    "GMAIL_USER",
    "GMAIL_APP_PASSWORD",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "FIRESTORE_WEBHOOK_SECRET",
    "GEMINI_API_KEY",
    "CERTIFICATE_SALT",
    "SEDS_NTN",
    "SEDS_BANK_NAME",
    "SEDS_IBAN",
]

# Client-exposed build-time keys. Missing values break `next build`
# (Firebase init) or degrade features (Drive picker, push).
WARN_KEYS = [
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
    "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
    "NEXT_PUBLIC_GOOGLE_DRIVE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_VAPID_KEY",
]

# Substrings that mark a value as an unfilled template placeholder.
PLACEHOLDER_MARKERS = ("your_", "example", "placeholder", "xxx")

# Exact template example values seen in .env.example / .env.local.template.
KNOWN_PLACEHOLDER_VALUES = frozenset(
    {
        "0000000-0",
        "PK00_0000_0000_0000_0000_0000",
        "your_project_id",
        "your_sender_id",
        "your_app_id",
        "your_measurement_id",
    }
)

STATUS_OK = "OK"
STATUS_EMPTY = "EMPTY"
STATUS_MISSING = "MISSING"
STATUS_PLACEHOLDER = "PLACEHOLDER"


def find_repo_root(hint=None):
    """Locate the repo root (directory containing package.json)."""
    candidates = []
    if hint:
        candidates.append(Path(hint))
    candidates.append(Path.cwd())
    candidates.append(Path(__file__).resolve().parent.parent)
    for base in candidates:
        base = base.resolve()
        for probe in (base, base.parent):
            if (probe / "package.json").exists():
                return probe
    return Path.cwd().resolve()


def parse_env_file(path):
    """Parse a simple KEY=VALUE dotenv file. Returns dict of key -> (value, line)."""
    values = {}
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return values
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # Strip a single layer of surrounding quotes and inline comments.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if "#" in value and not value.startswith("{"):
            value = value.split("#", 1)[0].strip()
        if key:
            values[key] = (value, lineno)
    return values


def classify(value):
    """Return a status for a raw value string (never logs the value itself)."""
    if value is None:
        return STATUS_MISSING
    stripped = value.strip()
    if stripped == "":
        return STATUS_EMPTY
    lowered = stripped.lower()
    if lowered in KNOWN_PLACEHOLDER_VALUES:
        return STATUS_PLACEHOLDER
    if any(marker in lowered for marker in PLACEHOLDER_MARKERS):
        return STATUS_PLACEHOLDER
    return STATUS_OK


def collect(repo_root, env_file):
    """Merge dotenv values with process env (env wins). Returns key -> (status, source)."""
    file_values = parse_env_file(env_file) if env_file.exists() else {}
    source_label = env_file.name
    merged = {}
    for key in REQUIRED_KEYS + WARN_KEYS:
        if key in os.environ:
            merged[key] = (classify(os.environ.get(key)), "environment")
        elif key in file_values:
            value, _lineno = file_values[key]
            merged[key] = (classify(value), source_label)
        else:
            merged[key] = (STATUS_MISSING, "-")
    return merged, env_file.exists()


def report(merged, env_found, env_file):
    """Print the structured status report. Returns counts dict."""
    counts = {STATUS_OK: 0, STATUS_EMPTY: 0, STATUS_MISSING: 0, STATUS_PLACEHOLDER: 0}

    print("=" * 64)
    print("SEDS PAKISTAN ENV VALIDATOR")
    print("=" * 64)
    print("env file: {} ({})".format(env_file, "found" if env_found else "not found"))
    print("")

    print("--- Required server keys (needed for full production functionality) ---")
    for key in REQUIRED_KEYS:
        status, source = merged[key]
        counts[status] += 1
        print("[{}] {} (source: {})".format(status, key, source))
    print("")

    print("--- Client build keys (missing values break `next build` or features) ---")
    for key in WARN_KEYS:
        status, source = merged[key]
        counts[status] += 1
        print("[{}] {} (source: {})".format(status, key, source))
    print("")

    total = len(REQUIRED_KEYS) + len(WARN_KEYS)
    print("--- Summary ---")
    print("checked: {}".format(total))
    print("ok: {}".format(counts[STATUS_OK]))
    print("placeholder: {}".format(counts[STATUS_PLACEHOLDER]))
    print("empty: {}".format(counts[STATUS_EMPTY]))
    print("missing: {}".format(counts[STATUS_MISSING]))
    if counts[STATUS_PLACEHOLDER] or counts[STATUS_EMPTY] or counts[STATUS_MISSING]:
        print("action: fill real values before deploy (see .env.local.template)")
    else:
        print("action: none, all keys look real")
    return counts


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Validate SEDS Pakistan env configuration (report only, exit 0)."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        default=True,
        help="Run the environment check (default behavior).",
    )
    parser.add_argument(
        "--env-file",
        default=None,
        help="Path to the dotenv file (default: <repo-root>/.env.local).",
    )
    parser.add_argument(
        "--repo-path",
        default=None,
        help="Repo root hint (default: auto-detect from cwd or script location).",
    )
    args = parser.parse_args(argv)

    repo_root = find_repo_root(args.repo_path)
    env_file = (
        Path(args.env_file).resolve()
        if args.env_file
        else (repo_root / ".env.local").resolve()
    )
    merged, env_found = collect(repo_root, env_file)
    report(merged, env_found, env_file)
    # Always exit 0: this is a diagnostic report, never a build gate.
    return 0


if __name__ == "__main__":
    sys.exit(main())
