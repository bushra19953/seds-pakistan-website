"""External Services, Webhooks, and Hosting Configuration Auditor.

This tool scans Next.js and Firebase codebases for Google APIs, email services,
webhooks, hosting redirects and rewrites, and environment variable definitions.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

CODE_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".mjs"}

GOOGLE_PATTERNS = [
    ("google_oauth", re.compile(r"""GoogleAuthProvider|google-auth-library|accounts\.google\.com""")),
    ("google_drive", re.compile(r"""google\.drive|drive\.files\.create|googleapis/build/src/apis/drive""")),
    ("google_sheets", re.compile(r"""google\.sheets|sheets\.spreadsheets|spreadsheets\.values""")),
    ("cloud_functions", re.compile(r"""httpsCallable|getFunctions|firebase-functions""")),
]

EMAIL_PATTERNS = [
    ("resend", re.compile(r"""\b(?:resend|Resend)\b""")),
    ("sendgrid", re.compile(r"""@sendgrid/mail|sgMail""")),
    ("nodemailer", re.compile(r"""\bnodemailer\b|createTransport""")),
    ("postmark", re.compile(r"""\bpostmark\b""")),
    ("aws_ses", re.compile(r"""@aws-sdk/client-ses|SendEmailCommand""")),
]

WEBHOOK_PATTERNS = [
    ("discord", re.compile(r"""discord\.com/api/webhooks|DISCORD_WEBHOOK_URL""")),
    ("slack", re.compile(r"""hooks\.slack\.com/services|SLACK_WEBHOOK_URL""")),
    ("telegram", re.compile(r"""api\.telegram\.org/bot|TELEGRAM_BOT_TOKEN""")),
    ("whatsapp", re.compile(r"""graph\.facebook\.com/v[0-9.]+|WHATSAPP_TOKEN""")),
    ("stripe", re.compile(r"""stripe\.webhooks\.constructEvent|\bstripe\b""")),
]

HARDCODED_SECRET_PATTERNS = [
    (re.compile(r"""['"]AIzaSy[A-Za-z0-9_\-]{33}['"]"""), "Firebase Web API Key"),
    (re.compile(r"""['"]sk_live_[A-Za-z0-9]{24,}['"]"""), "Stripe Live Secret Key"),
    (re.compile(r"""['"]ghp_[A-Za-z0-9]{36}['"]"""), "GitHub Personal Access Token"),
    (re.compile(r"""['"]xoxb-[0-9]{11,13}-[0-9]{11,13}-[A-Za-z0-9]{24}['"]"""), "Slack Bot Token"),
]


def read_text_safe(file_path: Path) -> str:
    """Read file content with UTF-8 encoding or replacement fallback."""
    try:
        return file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def strip_js_comments(text: str) -> str:
    """Strip line and block comments from JavaScript source code."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        if text[i : i + 2] == "//":
            end = text.find("\n", i)
            if end == -1:
                break
            i = end
        elif text[i : i + 2] == "/*":
            end = text.find("*/", i + 2)
            if end == -1:
                break
            i = end + 2
        elif text[i] in ("'", '"', "`"):
            quote = text[i]
            out.append(quote)
            i += 1
            while i < n and text[i] != quote:
                if text[i] == "\\" and i + 1 < n:
                    out.append(text[i : i + 2])
                    i += 2
                else:
                    out.append(text[i])
                    i += 1
            if i < n:
                out.append(text[i])
                i += 1
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def extract_enclosing_block(content: str, pattern: str) -> str:
    """Extract block delimited by brace tokens following regex pattern match."""
    match = re.search(pattern, content)
    if not match:
        return ""
    start_idx = match.end() - 1
    depth = 0
    idx = start_idx
    length = len(content)
    while idx < length:
        ch = content[idx]
        if ch in ("'", '"', "`"):
            quote = ch
            idx += 1
            while idx < length and content[idx] != quote:
                if content[idx] == "\\" and idx + 1 < length:
                    idx += 2
                else:
                    idx += 1
            if idx < length:
                idx += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return content[start_idx : idx + 1]
        idx += 1
    return content[start_idx:]


def extract_route_objects(scope_text: str, is_redirect: bool = False) -> List[Dict[str, Any]]:
    """Extract route mappings supporting flexible properties and key order."""
    cleaned = strip_js_comments(scope_text)
    brace_stack: List[int] = []
    matched_ranges: List[Tuple[int, int]] = []
    routes: List[Dict[str, Any]] = []

    i = 0
    n = len(cleaned)
    while i < n:
        ch = cleaned[i]
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            while i < n and cleaned[i] != quote:
                if cleaned[i] == "\\" and i + 1 < n:
                    i += 2
                else:
                    i += 1
            if i < n:
                i += 1
            continue
        if ch == "{":
            brace_stack.append(i)
        elif ch == "}":
            if brace_stack:
                start = brace_stack.pop()
                already_contains_inner = any(start <= r_start and i >= r_end for r_start, r_end in matched_ranges)
                if not already_contains_inner:
                    block = cleaned[start : i + 1]
                    src_m = re.search(r"""\bsource\s*:\s*['"]([^'"]+)['"]""", block)
                    dst_m = re.search(r"""\bdestination\s*:\s*['"]([^'"]+)['"]""", block)
                    if src_m and dst_m:
                        matched_ranges.append((start, i + 1))
                        src = src_m.group(1)
                        dst = dst_m.group(1)
                        if is_redirect:
                            perm_m = re.search(r"""\bpermanent\s*:\s*(true|false)\b""", block)
                            perm = perm_m.group(1) == "true" if perm_m else True
                            routes.append({
                                "source": src,
                                "destination": dst,
                                "permanent": perm,
                            })
                        else:
                            routes.append({
                                "source": src,
                                "destination": dst,
                            })
        i += 1

    return routes


def parse_next_config(repo_path: Path) -> Dict[str, Any]:
    """Inspect next.config.js, next.config.mjs, or next.config.ts for routing rules."""
    candidates = [
        repo_path / "next.config.js",
        repo_path / "next.config.mjs",
        repo_path / "next.config.ts",
    ]

    for cand in candidates:
        if cand.is_file():
            content = read_text_safe(cand)
            rel_path = str(cand.relative_to(repo_path)).replace("\\", "/")

            redirects: List[Dict[str, Any]] = []
            rewrites: List[Dict[str, Any]] = []
            headers: List[Dict[str, Any]] = []

            # Isolate redirects block if present
            red_scope = extract_enclosing_block(
                content,
                r"""\bredirects\s*(?:\([^)]*\)|:\s*(?:async\s*)?\([^)]*\)\s*=>)?\s*\{""",
            )

            # Isolate rewrites block if present
            rew_scope = extract_enclosing_block(
                content,
                r"""\brewrites\s*(?:\([^)]*\)|:\s*(?:async\s*)?\([^)]*\)\s*=>)?\s*\{""",
            )

            if red_scope:
                redirects.extend(extract_route_objects(red_scope, is_redirect=True))

            if rew_scope:
                rewrites.extend(extract_route_objects(rew_scope, is_redirect=False))

            # Fallback if function blocks were not detected
            if not red_scope and not rew_scope:
                for r in extract_route_objects(content, is_redirect=True):
                    redirects.append(r)


            # Check for security headers
            has_csp = "Content-Security-Policy" in content
            has_cors = "Access-Control-Allow-Origin" in content
            if has_csp or has_cors or "headers(" in content or "headers:" in content:
                headers.append({
                    "has_csp": has_csp,
                    "has_cors": has_cors,
                    "file": rel_path,
                })

            return {
                "present": True,
                "file_path": rel_path,
                "redirects": redirects,
                "rewrites": rewrites,
                "headers": headers,
            }

    return {
        "present": False,
        "file_path": None,
        "redirects": [],
        "rewrites": [],
        "headers": [],
    }


def parse_vercel_config(repo_path: Path) -> Dict[str, Any]:
    """Inspect vercel.json if present for redirects and headers."""
    vpath = repo_path / "vercel.json"
    if not vpath.is_file():
        return {"present": False, "redirects": [], "rewrites": [], "headers": []}

    try:
        data = json.loads(read_text_safe(vpath))
        return {
            "present": True,
            "file_path": "vercel.json",
            "redirects": data.get("redirects", []),
            "rewrites": data.get("rewrites", []),
            "headers": data.get("headers", []),
        }
    except Exception:
        return {"present": True, "file_path": "vercel.json", "redirects": [], "rewrites": [], "headers": []}


def parse_firebase_config(repo_path: Path) -> Dict[str, Any]:
    """Inspect firebase.json if present for hosting rewrites and redirects."""
    fpath = repo_path / "firebase.json"
    if not fpath.is_file():
        return {"present": False, "redirects": [], "rewrites": [], "headers": []}

    try:
        data = json.loads(read_text_safe(fpath))
        hosting = data.get("hosting", {})
        if isinstance(hosting, list):
            hosting = hosting[0] if hosting else {}

        return {
            "present": True,
            "file_path": "firebase.json",
            "redirects": hosting.get("redirects", []),
            "rewrites": hosting.get("rewrites", []),
            "headers": hosting.get("headers", []),
        }
    except Exception:
        return {"present": True, "file_path": "firebase.json", "redirects": [], "rewrites": [], "headers": []}


def scan_environment_variables(repo_path: Path) -> Tuple[List[Dict[str, Any]], Set[str]]:
    """Scan process.env variables and check .env.example definitions."""
    env_usages: Dict[str, int] = {}
    example_vars: Set[str] = set()

    # Read .env.example files
    example_files = [
        repo_path / ".env.example",
        repo_path / ".env.local.example",
        repo_path / ".env.sample",
    ]
    for ef in example_files:
        if ef.is_file():
            text = read_text_safe(ef)
            for line in text.split("\n"):
                clean = line.strip()
                if clean and not clean.startswith("#") and "=" in clean:
                    var_name = clean.split("=")[0].strip()
                    example_vars.add(var_name)

    env_regex = re.compile(r"""process\.env\.([A-Z0-9_]+)""")

    for entry in repo_path.rglob("*"):
        if not entry.is_file():
            continue
        if "node_modules" in entry.parts or ".next" in entry.parts or ".git" in entry.parts:
            continue
        if entry.suffix not in CODE_EXTENSIONS:
            continue

        content = read_text_safe(entry)
        for m in env_regex.finditer(content):
            vname = m.group(1)
            env_usages[vname] = env_usages.get(vname, 0) + 1

    var_list: List[Dict[str, Any]] = [
        {
            "name": name,
            "occurrences": count,
            "in_example": name in example_vars,
        }
        for name, count in sorted(env_usages.items())
    ]
    return var_list, example_vars


def audit_external_services(repo_path: Path) -> Dict[str, Any]:
    """Audit external services, webhooks, hosting configs, and secrets."""
    resolved_repo = repo_path.resolve()
    if not resolved_repo.exists() or not resolved_repo.is_dir():
        raise ValueError(f"Target repository directory does not exist: {resolved_repo}")

    google_apis: List[Dict[str, Any]] = []
    email_services: List[Dict[str, Any]] = []
    webhooks: List[Dict[str, Any]] = []
    other_apis: List[Dict[str, Any]] = []
    security_findings: List[Dict[str, Any]] = []

    for entry in resolved_repo.rglob("*"):
        if not entry.is_file():
            continue
        if "node_modules" in entry.parts or ".next" in entry.parts or ".git" in entry.parts:
            continue
        if entry.suffix not in CODE_EXTENSIONS:
            continue

        rel_path = str(entry.relative_to(resolved_repo)).replace("\\", "/")
        content = read_text_safe(entry)

        # 1. Google APIs
        for label, pattern in GOOGLE_PATTERNS:
            for m in pattern.finditer(content):
                line_num = content[:m.start()].count("\n") + 1
                google_apis.append({
                    "service": label,
                    "file": rel_path,
                    "line": line_num,
                    "match": m.group(0),
                })

        # 2. Email Services
        for label, pattern in EMAIL_PATTERNS:
            for m in pattern.finditer(content):
                line_num = content[:m.start()].count("\n") + 1
                email_services.append({
                    "service": label,
                    "file": rel_path,
                    "line": line_num,
                })

        # 3. Webhooks & Communication
        for label, pattern in WEBHOOK_PATTERNS:
            for m in pattern.finditer(content):
                line_num = content[:m.start()].count("\n") + 1
                webhooks.append({
                    "service": label,
                    "file": rel_path,
                    "line": line_num,
                })

        # Check for webhook signature verification on webhook routes
        if "webhook" in rel_path.lower():
            has_sig_check = bool(
                re.search(r"""createHmac|timingSafeEqual|constructEvent|verifyHeader""", content)
            )
            if not has_sig_check:
                security_findings.append({
                    "severity": "HIGH",
                    "issue": "Missing webhook signature verification",
                    "file": rel_path,
                    "description": "Webhook handler does not verify cryptographic signature from caller.",
                })

        # 4. Outbound external HTTP fetch calls
        fetch_matches = re.finditer(r"""fetch\s*\(\s*['"]https?://([^/'"\s]+)[^'"]*['"]""", content)
        for fm in fetch_matches:
            domain = fm.group(1)
            line_num = content[:fm.start()].count("\n") + 1
            if not any(known in domain for known in ("localhost", "127.0.0.1", "googleapis.com", "firebase")):
                other_apis.append({
                    "domain": domain,
                    "file": rel_path,
                    "line": line_num,
                })

        # 5. Hardcoded secrets check
        for pattern, secret_type in HARDCODED_SECRET_PATTERNS:
            for m in pattern.finditer(content):
                line_num = content[:m.start()].count("\n") + 1
                security_findings.append({
                    "severity": "HIGH",
                    "issue": f"Hardcoded {secret_type}",
                    "file": rel_path,
                    "line": line_num,
                    "description": "Plaintext secret token found in repository source file.",
                })

    # Hosting configs
    next_cfg = parse_next_config(resolved_repo)
    vercel_cfg = parse_vercel_config(resolved_repo)
    firebase_cfg = parse_firebase_config(resolved_repo)

    env_vars, example_vars = scan_environment_variables(resolved_repo)

    total_redirects = (
        len(next_cfg["redirects"])
        + len(vercel_cfg["redirects"])
        + len(firebase_cfg["redirects"])
    )
    total_rewrites = (
        len(next_cfg["rewrites"])
        + len(vercel_cfg["rewrites"])
        + len(firebase_cfg["rewrites"])
    )

    total_services_count = (
        len({g["service"] for g in google_apis})
        + len({e["service"] for e in email_services})
        + len({w["service"] for w in webhooks})
        + len({o["domain"] for o in other_apis})
    )

    summary = {
        "total_external_services": total_services_count,
        "google_apis_count": len(google_apis),
        "email_services_count": len(email_services),
        "webhooks_count": len(webhooks),
        "other_apis_count": len(other_apis),
        "redirects_count": total_redirects,
        "rewrites_count": total_rewrites,
        "env_variables_detected": len(env_vars),
        "security_findings_count": len(security_findings),
    }

    return {
        "scanner": "audit_external_services.py",
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "repo_path": str(resolved_repo).replace("\\", "/"),
        "summary": summary,
        "services": {
            "google_apis": google_apis,
            "email_services": email_services,
            "webhooks": webhooks,
            "other_apis": other_apis,
        },
        "hosting_configs": {
            "next_config": next_cfg,
            "vercel_json": vercel_cfg,
            "firebase_json": firebase_cfg,
        },
        "environment_variables": env_vars,
        "security_findings": security_findings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit external services, webhooks, and hosting redirects.")
    parser.add_argument("--repo-path", required=True, type=Path, help="Path to target Next.js repository.")
    parser.add_argument("--output", type=Path, default=Path("external_services.json"), help="Output JSON path.")
    args = parser.parse_args()

    inventory = audit_external_services(args.repo_path)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(inventory, f, indent=2)

    print(
        f"Audited external services. Services: {inventory['summary']['total_external_services']}, "
        f"Redirects: {inventory['summary']['redirects_count']}. "
        f"Output saved to {args.output}"
    )


if __name__ == "__main__":
    main()
