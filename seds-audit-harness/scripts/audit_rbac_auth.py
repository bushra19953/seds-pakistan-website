"""Role-Based Access Control and Authentication Auditor.

This tool audits Next.js and Firebase codebases for authentication SDK calls,
multi-tenant chapter isolation, session persistence, custom claims, and
role checks. It maps required roles to actions and flags client-only security gaps.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

CODE_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx"}

AUTH_METHODS = [
    "signInWithEmailAndPassword",
    "signInWithPopup",
    "signInWithRedirect",
    "createUserWithEmailAndPassword",
    "signInAnonymously",
    "signInWithCustomToken",
    "onAuthStateChanged",
    "getIdTokenResult",
    "getIdToken",
    "signOut",
    "sendPasswordResetEmail",
    "updateProfile",
    "updatePassword",
    "verifyIdToken",
    "setCustomUserClaims",
    "createSessionCookie",
    "verifySessionCookie",
]

ROLE_CHECK_PATTERNS = [
    (
        re.compile(
            r"""(?:\b(?:decoded|token|user|claims|session|profile|[a-zA-Z0-9_]+)\.)?(?:role|userRole|claimRole)\s*(?:===|==|!==|!=)\s*['"]([a-zA-Z0-9_\-]+)['"]"""
        ),
        "equality_check",
    ),
    (
        re.compile(
            r"""['"]([a-zA-Z0-9_\-]+)['"]\s*(?:===|==|!==|!=)\s*(?:\b(?:decoded|token|user|claims|session|profile|[a-zA-Z0-9_]+)\.)?(?:role|userRole|claimRole)"""
        ),
        "equality_check_reversed",
    ),
    (re.compile(r"""hasRole\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)"""), "helper_function"),
    (re.compile(r"""requireRole\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)"""), "guard_function"),
    (re.compile(r"""checkRole\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)"""), "guard_function"),
    (re.compile(r"""roles?\.(?:includes|has)\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)"""), "array_inclusion"),
    (
        re.compile(
            r"""case\s+['"](admin|chapter_lead|regional_rep|member|guest|superadmin|lead|officer|council)['"]\s*:"""
        ),
        "switch_case",
    ),
]

ARRAY_ROLE_CHECK_PATTERN = re.compile(
    r"""\[([^[\]]+)\]\s*\.(?:includes|has)\s*\([^)]*(?:role|userRole|claimRole)"""
)

CUSTOM_CLAIMS_PATTERN = re.compile(
    r"""(?:claims|token\.claims|decodedToken|decoded)\.([a-zA-Z0-9_]+)|setCustomUserClaims|getIdTokenResult"""
)

FIRESTORE_RULE_ROLE_PATTERN = re.compile(
    r"""(?:token\.role|token\.roles|role)\s*(?:==|!=)\s*['"]([a-zA-Z0-9_\-]+)['"]"""
)

MULTI_TENANT_QUERY_PATTERN = re.compile(
    r"""where\s*\(\s*['"](chapterId|tenantId|chapter_id|tenant_id)['"]\s*,\s*['"](==|in|array-contains)['"]\s*,\s*([^)]+)\)"""
)

SESSION_COOKIE_PATTERNS = [
    re.compile(r"""(?:cookies\s*\(\s*\)|cookieStore|cookies|request\.cookies|req\.cookies)\.get\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)"""),
    re.compile(r"""\.get\s*\(\s*['"](__session|session|token|auth_token)['"]\s*\)"""),
    re.compile(r"""['"]__session['"]"""),
    re.compile(r"""createSessionCookie|verifySessionCookie"""),
]


MULTI_TENANT_COLLECTIONS = {
    "projects",
    "chapters",
    "members",
    "events",
    "rfqs",
    "bids",
    "inquiries",
    "teams",
    "submissions",
}


def read_text_safe(file_path: Path) -> str:
    """Read file content with UTF-8 encoding or replacement fallback."""
    try:
        return file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def detect_use_client(content: str) -> bool:
    """Detect whether a file contains a use client directive."""
    prefix = content[:1000]
    return bool(re.search(r"""^[\s]*['"]use\s+client['"]""", prefix, flags=re.MULTILINE))


def detect_use_server(content: str) -> bool:
    """Detect whether a file contains a use server directive."""
    prefix = content[:1000]
    return bool(re.search(r"""^[\s]*['"]use\s+server['"]""", prefix, flags=re.MULTILINE))


def map_file_to_route(rel_path: str) -> Optional[str]:
    """Map a repository file path to a URL route path."""
    p = Path(rel_path)
    parts = list(p.parts)

    app_idx = -1
    for i, part in enumerate(parts):
        if part in ("app", "pages"):
            app_idx = i
            break

    if app_idx == -1:
        return None

    router_type = parts[app_idx]
    subparts = parts[app_idx + 1 :]

    if not subparts:
        return "/"

    last_part = subparts[-1]
    if router_type == "app":
        if last_part.startswith("page.") or last_part.startswith("route."):
            dir_parts = [
                sp
                for sp in subparts[:-1]
                if not (sp.startswith("(") and sp.endswith(")")) and not sp.startswith("@")
            ]
            if not dir_parts:
                return "/"
            return "/" + "/".join(dir_parts)
    elif router_type == "pages":
        stem = Path(last_part).stem
        dir_parts = subparts[:-1]
        if stem == "index":
            if not dir_parts:
                return "/"
            return "/" + "/".join(dir_parts)
        route_segments = dir_parts + [stem]
        return "/" + "/".join(route_segments)

    return None


def audit_rbac_auth(repo_path: Path) -> Dict[str, Any]:
    """Audit codebase for Firebase authentication, custom claims, and RBAC rules."""
    resolved_repo = repo_path.resolve()
    if not resolved_repo.exists() or not resolved_repo.is_dir():
        raise ValueError(f"Target repository directory does not exist: {resolved_repo}")

    auth_methods_map: Dict[str, List[Dict[str, Any]]] = {m: [] for m in AUTH_METHODS}
    custom_claims_found: Set[str] = set()
    role_occurrences: Dict[str, List[Dict[str, Any]]] = {}
    route_mappings: Dict[str, Dict[str, Any]] = {}
    security_findings: List[Dict[str, Any]] = []

    # Multi-tenant and session tracking
    chapter_scoped_queries: List[Dict[str, Any]] = []
    unscoped_multi_tenant_queries: List[Dict[str, Any]] = []
    session_cookie_occurrences: List[Dict[str, Any]] = []
    unprotected_api_routes: List[str] = []

    for entry in resolved_repo.rglob("*"):
        if not entry.is_file():
            continue
        if "node_modules" in entry.parts or ".next" in entry.parts or ".git" in entry.parts:
            continue
        if entry.suffix not in CODE_EXTENSIONS:
            continue

        rel_path = str(entry.relative_to(resolved_repo)).replace("\\", "/")
        content = read_text_safe(entry)

        is_client = detect_use_client(content)
        is_server = detect_use_server(content)
        route_path = map_file_to_route(rel_path)
        is_route_handler = entry.name.startswith("route.") or "/api/" in rel_path

        # 1. Auth method detection
        for method in AUTH_METHODS:
            pattern = rf"""\b{method}\b"""
            for m in re.finditer(pattern, content):
                line_num = content[:m.start()].count("\n") + 1
                auth_methods_map[method].append({
                    "file": rel_path,
                    "line": line_num,
                })

        # 2. Custom claims detection
        for m in CUSTOM_CLAIMS_PATTERN.finditer(content):
            claim_name = m.group(1) if m.group(1) else "custom_claim_operation"
            custom_claims_found.add(claim_name)

        # 3. Session cookie detection
        for pat in SESSION_COOKIE_PATTERNS:
            for match in pat.finditer(content):
                line_num = content[:match.start()].count("\n") + 1
                session_cookie_occurrences.append({
                    "file": rel_path,
                    "line": line_num,
                    "token": match.group(0),
                })

        # 4. Multi-tenant chapter isolation queries
        for match in MULTI_TENANT_QUERY_PATTERN.finditer(content):
            line_num = content[:match.start()].count("\n") + 1
            chapter_scoped_queries.append({
                "file": rel_path,
                "line": line_num,
                "field": match.group(1),
                "operator": match.group(2),
            })

        # Detect collections queried without tenant scoping
        col_matches = re.finditer(r"""collection\s*\([^,]+,\s*['"]([a-zA-Z0-9_\-]+)['"]\)""", content)
        for c_match in col_matches:
            col_target = c_match.group(1)
            if col_target in MULTI_TENANT_COLLECTIONS:
                # Check if file has chapterId or tenantId query
                if not re.search(r"""where\s*\(\s*['"](?:chapterId|tenantId|chapter_id|tenant_id)['"]""", content):
                    line_num = content[:c_match.start()].count("\n") + 1
                    unscoped_multi_tenant_queries.append({
                        "file": rel_path,
                        "line": line_num,
                        "collection": col_target,
                    })

        # 5. Role check detection
        file_roles: Set[str] = set()
        for pattern, pattern_type in ROLE_CHECK_PATTERNS:
            for match in pattern.finditer(content):
                role_name = match.group(1).strip()
                if not role_name or len(role_name) > 30:
                    continue
                file_roles.add(role_name)
                line_num = content[:match.start()].count("\n") + 1

                if role_name not in role_occurrences:
                    role_occurrences[role_name] = []
                role_occurrences[role_name].append({
                    "file": rel_path,
                    "line": line_num,
                    "pattern_type": pattern_type,
                    "is_client_component": is_client,
                })

        for match in ARRAY_ROLE_CHECK_PATTERN.finditer(content):
            array_body = match.group(1)
            literals = re.findall(r"""['"]([a-zA-Z0-9_\-]+)['"]""", array_body)
            line_num = content[:match.start()].count("\n") + 1
            for r in literals:
                file_roles.add(r)
                if r not in role_occurrences:
                    role_occurrences[r] = []
                role_occurrences[r].append({
                    "file": rel_path,
                    "line": line_num,
                    "pattern_type": "array_inclusion",
                    "is_client_component": is_client,
                })

        # 6. Route role mapping and security gaps
        if route_path or file_roles:
            target_key = route_path or rel_path
            enforcement = "server"
            if is_client and not is_server:
                enforcement = "client"
            elif is_client and is_server:
                enforcement = "mixed"

            if target_key not in route_mappings:
                route_mappings[target_key] = {
                    "target": target_key,
                    "file_path": rel_path,
                    "is_route": route_path is not None,
                    "enforcement_level": enforcement,
                    "roles_required": sorted(list(file_roles)),
                    "client_component": is_client,
                    "server_component": not is_client or is_server,
                }
            else:
                existing_roles = set(route_mappings[target_key]["roles_required"])
                existing_roles.update(file_roles)
                route_mappings[target_key]["roles_required"] = sorted(list(existing_roles))

            # Security finding: Client-only RBAC check
            if is_client and file_roles and not is_server:
                security_findings.append({
                    "severity": "HIGH",
                    "issue": "Client-only RBAC check",
                    "file": rel_path,
                    "target": target_key,
                    "roles": sorted(list(file_roles)),
                    "description": "Client component checks user role without backend server verification.",
                })

        # 7. Route handler mutation guard inspection
        if is_route_handler:
            has_mutation_handler = bool(
                re.search(r"""export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b""", content)
            )
            has_auth_check = bool(
                re.search(
                    r"""verifyIdToken|verifySessionCookie|getServerSession|requireRole|hasRole|request\.cookies|cookies\(\)""",
                    content,
                )
            )
            if has_mutation_handler and not has_auth_check:
                unprotected_api_routes.append(rel_path)
                security_findings.append({
                    "severity": "HIGH",
                    "issue": "Unprotected mutating API route",
                    "file": rel_path,
                    "target": route_path or rel_path,
                    "roles": [],
                    "description": "API route handles mutation without backend token verification.",
                })

    # 8. Firestore rules role inspection
    rules_file = resolved_repo / "firestore.rules"
    if rules_file.is_file():
        rules_content = read_text_safe(rules_file)
        rel_rules = str(rules_file.relative_to(resolved_repo)).replace("\\", "/")
        for match in FIRESTORE_RULE_ROLE_PATTERN.finditer(rules_content):
            role_name = match.group(1).strip()
            line_num = rules_content[:match.start()].count("\n") + 1
            if role_name not in role_occurrences:
                role_occurrences[role_name] = []
            role_occurrences[role_name].append({
                "file": rel_rules,
                "line": line_num,
                "pattern_type": "firestore_rule",
                "is_client_component": False,
            })

    active_auth_methods = {k: v for k, v in auth_methods_map.items() if v}

    roles_summary = [
        {
            "role": role,
            "check_count": len(items),
            "files": sorted(list({i["file"] for i in items})),
        }
        for role, items in sorted(role_occurrences.items())
    ]

    summary = {
        "roles_discovered": sorted(list(role_occurrences.keys())),
        "total_role_checks": sum(len(items) for items in role_occurrences.values()),
        "auth_methods_detected": len(active_auth_methods),
        "custom_claims_detected": sorted(list(custom_claims_found)),
        "protected_targets_count": sum(1 for m in route_mappings.values() if m["roles_required"]),
        "client_only_guarded_targets": sum(
            1 for m in route_mappings.values() if m["roles_required"] and m["enforcement_level"] == "client"
        ),
        "server_guarded_targets": sum(
            1 for m in route_mappings.values() if m["roles_required"] and m["enforcement_level"] in ("server", "mixed")
        ),
        "multi_tenant_scoped_queries": len(chapter_scoped_queries),
        "session_cookie_usages": len(session_cookie_occurrences),
        "unprotected_api_routes": len(unprotected_api_routes),
        "security_findings_count": len(security_findings),
    }

    return {
        "scanner": "audit_rbac_auth.py",
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "repo_path": str(resolved_repo).replace("\\", "/"),
        "summary": summary,
        "roles": roles_summary,
        "auth_methods": active_auth_methods,
        "route_role_mappings": list(route_mappings.values()),
        "multi_tenancy": {
            "chapter_scoped_queries": chapter_scoped_queries,
            "unscoped_multi_tenant_queries": unscoped_multi_tenant_queries,
            "tenant_collections_audited": sorted(list(MULTI_TENANT_COLLECTIONS)),
        },
        "session_persistence": {
            "cookie_based_sessions": len(session_cookie_occurrences) > 0,
            "session_cookie_occurrences": session_cookie_occurrences,
            "ssr_session_support": any(
                "cookies(" in occ["token"] or "request.cookies" in occ["token"]
                for occ in session_cookie_occurrences
            ),
        },
        "security_findings": security_findings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit RBAC rules and Firebase Authentication usage.")
    parser.add_argument("--repo-path", required=True, type=Path, help="Path to target Next.js/Firebase repository.")
    parser.add_argument("--output", type=Path, default=Path("rbac_auth_inventory.json"), help="Output JSON path.")
    args = parser.parse_args()

    inventory = audit_rbac_auth(args.repo_path)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(inventory, f, indent=2)

    print(f"Audited RBAC. Discovered {len(inventory['summary']['roles_discovered'])} roles. Output saved to {args.output}")


if __name__ == "__main__":
    main()
