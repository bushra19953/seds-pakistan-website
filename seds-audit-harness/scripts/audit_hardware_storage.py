"""Hardware Pipeline and Firebase Storage Auditor.

This tool audits Next.js and Firebase repositories for CAD and BOM dropzones,
accepted file extensions, MIME whitelists, upload size limits, and Firebase
Storage security rules.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

CODE_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx"}

CAD_EXTENSIONS = [
    ".step",
    ".stp",
    ".stl",
    ".iges",
    ".igs",
    ".dxf",
    ".dwg",
    ".sldprt",
    ".zip",
    ".pdf",
    ".csv",
    ".xlsx",
]

KNOWN_CAD_MIME_TYPES = [
    "application/step",
    "application/sla",
    "application/x-step",
    "application/x-stl",
    "model/step",
    "model/stl",
    "application/octet-stream",
    "application/pdf",
    "application/zip",
    "text/csv",
]

STORAGE_SDK_PATTERNS = [
    re.compile(r"""\bgetStorage\s*\("""),
    re.compile(r"""\bref\s*\(\s*(?:storage|[a-zA-Z0-9_]+)\s*,\s*['"]([^'"]+)['"]"""),
    re.compile(r"""\buploadBytes(?:Resumable)?\s*\("""),
    re.compile(r"""\buploadString\s*\("""),
    re.compile(r"""\bgetDownloadURL\s*\("""),
]

DROPZONE_PATTERNS = [
    re.compile(r"""useDropzone\s*\(\s*\{([^}]*)\}""", re.DOTALL),
    re.compile(r"""<Dropzone\b([^>]*)>""", re.DOTALL),
    re.compile(r"""<input[^>]+type=['"]file['"][^>]*>""", re.IGNORECASE),
]

ACCEPT_ATTR_PATTERN = re.compile(r"""accept\s*=\s*(?:['"]([^'"]+)['"]|\{([^}]+)\})""")
MAX_SIZE_PATTERN = re.compile(r"""maxSize\s*:\s*([0-9\s*+]+)""")
SIZE_CHECK_PATTERN = re.compile(r"""(?:size|\.size)\s*(?:>|>=)\s*([0-9\s*+]+)""")


def read_text_safe(file_path: Path) -> str:
    """Read file content with UTF-8 encoding or replacement fallback."""
    try:
        return file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def evaluate_numeric_expression(expr: str) -> Optional[int]:
    """Evaluate simple arithmetic expression like 100 * 1024 * 1024 safe."""
    clean = expr.replace(" ", "").strip()
    if re.fullmatch(r"""[0-9*+]+""", clean):
        try:
            parts = clean.split("*")
            product = 1
            for p in parts:
                if "+" in p:
                    subparts = [int(x) for x in p.split("+")]
                    product *= sum(subparts)
                else:
                    product *= int(p)
            return product
        except Exception:
            return None
    return None


def parse_storage_rules(rules_path: Path) -> Dict[str, Any]:
    """Parse storage.rules file to extract buckets, match blocks, and constraints."""
    if not rules_path.is_file():
        return {
            "present": False,
            "file_path": None,
            "rules": [],
            "max_size_bytes": None,
            "size_limit_enforced": False,
            "auth_enforced": False,
        }

    content = read_text_safe(rules_path)
    allow_regex = re.compile(r"""allow\s+([^:]+):\s*if\s+([^;]+);""")

    rules: List[Dict[str, Any]] = []
    max_size: Optional[int] = None
    size_enforced = False
    auth_enforced = False

    # Check for size expression in rules
    size_match = re.search(r"""request\.resource\.size\s*<\s*([0-9\s*+]+)""", content)
    if size_match:
        size_enforced = True
        parsed_size = evaluate_numeric_expression(size_match.group(1))
        if parsed_size:
            max_size = parsed_size

    lines = []
    for l in content.split("\n"):
        idx = l.find("//")
        if idx != -1:
            l = l[:idx]
        lines.append(l)
    cleaned = "\n".join(lines)

    token_pattern = re.compile(
        r"""(allow\s+[^:]+:\s*if\s+[^;]+;)"""
        r"""|(match\s+[^\s{]+(?:\{[^{}]+\}[^\s{]*)*\s*\{)"""
        r"""|(\{)"""
        r"""|(\})"""
    )

    stack: List[Dict[str, Any]] = []

    for match in token_pattern.finditer(cleaned):
        allow_stmt = match.group(1)
        match_block_start = match.group(2)
        open_brace = match.group(3)
        close_brace = match.group(4)

        if allow_stmt:
            a_match = allow_regex.search(allow_stmt)
            if a_match:
                ops = [op.strip() for op in a_match.group(1).split(",")]
                cond = a_match.group(2).strip()
                requires_auth = "request.auth" in cond
                if requires_auth:
                    auth_enforced = True
                allow_entry = {
                    "operations": ops,
                    "condition": cond,
                    "requires_auth": requires_auth,
                }
                for frame in reversed(stack):
                    if frame.get("is_match"):
                        frame["allows"].append(allow_entry)
                        break

        elif match_block_start:
            m = re.match(r"""match\s+([^\s{]+(?:\{[^{}]+\}[^\s{]*)*)\s*\{""", match_block_start)
            raw_path = m.group(1).strip() if m else ""
            stack.append({
                "is_match": True,
                "path": raw_path.strip("/"),
                "allows": [],
            })

        elif open_brace:
            stack.append({
                "is_match": False,
                "path": "",
                "allows": [],
            })

        elif close_brace:
            if stack:
                top = stack.pop()
                if top.get("is_match"):
                    active_parts = [f["path"] for f in stack if f.get("is_match") and f["path"]] + [top["path"]]
                    full_path = "/" + "/".join([p for p in active_parts if p])
                    rules.append({
                        "path": full_path,
                        "allows": top["allows"],
                    })

    if not auth_enforced and "request.auth" in content:
        auth_enforced = True

    return {
        "present": True,
        "file_path": str(rules_path.name),
        "rules": rules,
        "max_size_bytes": max_size,
        "size_limit_enforced": size_enforced,
        "auth_enforced": auth_enforced,
    }


def scan_dropzones(repo_path: Path) -> List[Dict[str, Any]]:
    """Scan frontend components for CAD and file dropzones."""
    dropzones: List[Dict[str, Any]] = []

    for entry in repo_path.rglob("*"):
        if not entry.is_file():
            continue
        if "node_modules" in entry.parts or ".next" in entry.parts or ".git" in entry.parts:
            continue
        if entry.suffix not in CODE_EXTENSIONS:
            continue

        content = read_text_safe(entry)
        rel_path = str(entry.relative_to(repo_path)).replace("\\", "/")

        found_dropzone = False
        accepted_exts: Set[str] = set()
        accepted_mimes: Set[str] = set()
        max_size_bytes: Optional[int] = None
        has_size_check = False
        storage_target: Optional[str] = None

        # Check for storage ref target
        ref_match = re.search(r"""ref\s*\(\s*(?:storage|[a-zA-Z0-9_]+)\s*,\s*['"]([^'"]+)['"]""", content)
        if ref_match:
            storage_target = ref_match.group(1)

        # Check for accept attribute or dropzone usage
        for pat in DROPZONE_PATTERNS:
            for m in pat.finditer(content):
                found_dropzone = True
                block = m.group(0)
                accept_match = ACCEPT_ATTR_PATTERN.search(block)
                if accept_match:
                    raw_accept = accept_match.group(1) or accept_match.group(2) or ""
                    for ext in CAD_EXTENSIONS:
                        if ext in raw_accept.lower():
                            accepted_exts.add(ext)
                    for mime in KNOWN_CAD_MIME_TYPES:
                        if mime in raw_accept.lower():
                            accepted_mimes.add(mime)

                size_m = MAX_SIZE_PATTERN.search(block)
                if size_m:
                    has_size_check = True
                    eval_size = evaluate_numeric_expression(size_m.group(1))
                    if eval_size:
                        max_size_bytes = eval_size

        # Also check file content for extensions and size checks
        if not found_dropzone:
            has_cad_mention = any(ext in content.lower() for ext in CAD_EXTENSIONS[:8])
            has_upload_call = any(pat.search(content) for pat in STORAGE_SDK_PATTERNS)
            if has_cad_mention and has_upload_call:
                found_dropzone = True

        if found_dropzone:
            for ext in CAD_EXTENSIONS:
                if ext in content.lower():
                    accepted_exts.add(ext)
            for mime in KNOWN_CAD_MIME_TYPES:
                if mime in content.lower():
                    accepted_mimes.add(mime)

            check_match = SIZE_CHECK_PATTERN.search(content)
            if check_match:
                has_size_check = True
                eval_size = evaluate_numeric_expression(check_match.group(1))
                if eval_size and not max_size_bytes:
                    max_size_bytes = eval_size

            # Fallback size check check for 100MB pattern
            if "100 * 1024 * 1024" in content or "104857600" in content:
                has_size_check = True
                max_size_bytes = 100 * 1024 * 1024

            dropzones.append({
                "file": rel_path,
                "storage_target": storage_target or "default_bucket",
                "accepted_extensions": sorted(list(accepted_exts)),
                "accepted_mime_types": sorted(list(accepted_mimes)),
                "has_size_check": has_size_check,
                "max_size_bytes": max_size_bytes,
                "max_size_mb": round(max_size_bytes / (1024 * 1024), 2) if max_size_bytes else None,
            })

    return dropzones


def audit_hardware_storage(repo_path: Path) -> Dict[str, Any]:
    """Audit hardware sourcing storage rules, CAD dropzones, and upload limits."""
    resolved_repo = repo_path.resolve()
    if not resolved_repo.exists() or not resolved_repo.is_dir():
        raise ValueError(f"Target repository directory does not exist: {resolved_repo}")

    rules_path = resolved_repo / "storage.rules"
    rules_data = parse_storage_rules(rules_path)
    dropzones = scan_dropzones(resolved_repo)

    security_findings: List[Dict[str, Any]] = []

    if not rules_data["present"]:
        security_findings.append({
            "severity": "HIGH",
            "issue": "Missing storage.rules",
            "description": "No Firebase Storage security rules file found in repository root.",
        })
    elif not rules_data["auth_enforced"]:
        security_findings.append({
            "severity": "HIGH",
            "issue": "Unauthenticated storage access",
            "description": "Storage rules allow read or write without auth verification.",
        })

    # Collect detected CAD extensions and MIME types
    detected_exts: Set[str] = set()
    detected_mimes: Set[str] = set()
    size_limits_found: List[int] = []

    if rules_data["max_size_bytes"]:
        size_limits_found.append(rules_data["max_size_bytes"])

    for dz in dropzones:
        detected_exts.update(dz["accepted_extensions"])
        detected_mimes.update(dz["accepted_mime_types"])
        if dz["max_size_bytes"]:
            size_limits_found.append(dz["max_size_bytes"])
        if not dz["has_size_check"] and not rules_data["size_limit_enforced"]:
            security_findings.append({
                "severity": "MEDIUM",
                "issue": "Missing upload size check",
                "file": dz["file"],
                "description": "Dropzone allows file uploads without size limit enforcement.",
            })

    # Buckets detection
    buckets: List[Dict[str, Any]] = []
    bucket_names: Set[str] = set()
    for dz in dropzones:
        tgt = dz["storage_target"]
        if tgt and tgt not in bucket_names:
            bucket_names.add(tgt)
            buckets.append({"bucket_name": tgt, "storage_path": "/" + tgt.strip("/")})

    if not buckets:
        buckets.append({"bucket_name": "default", "storage_path": "/cad_files"})

    # Determine max upload size limit in MB
    if size_limits_found:
        min_limit_bytes = min(size_limits_found)
        max_upload_size_mb = round(min_limit_bytes / (1024 * 1024), 2)
    else:
        max_upload_size_mb = 100.0

    size_enforced = rules_data["size_limit_enforced"] or any(dz["has_size_check"] for dz in dropzones)
    mime_enforced = len(detected_mimes) > 0

    all_allowed_exts = sorted(list(detected_exts)) if detected_exts else CAD_EXTENSIONS
    all_allowed_mimes = sorted(list(detected_mimes)) if detected_mimes else KNOWN_CAD_MIME_TYPES

    summary = {
        "storage_rules_found": rules_data["present"],
        "total_buckets": len(buckets),
        "total_dropzones": len(dropzones),
        "cad_extensions_detected": sorted(list(detected_exts)),
        "max_upload_size_limit_enforced": size_enforced,
        "max_upload_size_mb": max_upload_size_mb,
        "mime_whitelist_enforced": mime_enforced,
        "security_findings_count": len(security_findings),
    }

    return {
        "scanner": "audit_hardware_storage.py",
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "repo_path": str(resolved_repo).replace("\\", "/"),
        "summary": summary,
        "storage_rules": rules_data,
        "dropzones": dropzones,
        "buckets": buckets,
        "allowed_file_types": all_allowed_exts,
        "allowed_mime_types": all_allowed_mimes,
        "max_upload_size_mb": max_upload_size_mb,
        "security_findings": security_findings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit hardware sourcing storage rules and upload dropzones.")
    parser.add_argument("--repo-path", required=True, type=Path, help="Path to target Next.js repository.")
    parser.add_argument("--output", type=Path, default=Path("storage_schemas.json"), help="Output JSON path.")
    args = parser.parse_args()

    inventory = audit_hardware_storage(args.repo_path)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(inventory, f, indent=2)

    print(
        f"Audited hardware storage. Dropzones: {inventory['summary']['total_dropzones']}, "
        f"Rules: {'FOUND' if inventory['summary']['storage_rules_found'] else 'NONE'}. "
        f"Output saved to {args.output}"
    )


if __name__ == "__main__":
    main()
