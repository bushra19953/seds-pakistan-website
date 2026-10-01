"""Next.js Route Scanner.

This tool walks Next.js repositories, detects App Router and Pages Router
routes, identifies client versus server components, checks for server
actions, detects parallel route slots and intercepting routes, maps layout
trees and error boundaries, and flags authentication constraints.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

ROUTE_EXTENSIONS = {".tsx", ".ts", ".jsx", ".js"}
PAGE_FILENAMES = {"page.tsx", "page.ts", "page.jsx", "page.js"}
HANDLER_FILENAMES = {"route.tsx", "route.ts", "route.jsx", "route.js"}
LAYOUT_FILENAMES = {"layout.tsx", "layout.ts", "layout.jsx", "layout.js"}
ERROR_FILENAMES = {"error.tsx", "error.ts", "error.jsx", "error.js"}
GLOBAL_ERROR_FILENAMES = {"global-error.tsx", "global-error.ts", "global-error.jsx", "global-error.js"}
NOT_FOUND_FILENAMES = {"not-found.tsx", "not-found.ts", "not-found.jsx", "not-found.js"}
LOADING_FILENAMES = {"loading.tsx", "loading.ts", "loading.jsx", "loading.js"}

HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

ROLE_PATTERNS = [
    re.compile(
        r"""(?:\b(?:decoded|token|user|claims|session|profile|[a-zA-Z0-9_]+)\.)?(?:role|userRole|claimRole)\s*(?:===|==|!==|!=)\s*['"]([a-zA-Z0-9_\-]+)['"]"""
    ),
    re.compile(
        r"""['"]([a-zA-Z0-9_\-]+)['"]\s*(?:===|==|!==|!=)\s*(?:\b(?:decoded|token|user|claims|session|profile|[a-zA-Z0-9_]+)\.)?(?:role|userRole|claimRole)"""
    ),
    re.compile(r"""hasRole\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)"""),
    re.compile(r"""requireRole\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)"""),
    re.compile(r"""checkRole\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)"""),
    re.compile(r"""roles?\.(?:includes|has)\s*\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)"""),
    re.compile(r"""case\s+['"](admin|chapter_lead|regional_rep|member|guest|superadmin|lead|officer|council)['"]\s*:"""),
]

ARRAY_ROLE_PATTERN = re.compile(
    r"""\[([^[\]]+)\]\s*\.(?:includes|has)\s*\([^)]*(?:role|userRole|claimRole)"""
)

AUTH_SIGNALS = [
    ("next_auth_session", re.compile(r"""getServerSession|useSession|authOptions|getToken""")),
    ("firebase_auth", re.compile(r"""onAuthStateChanged|signInWith|verifyIdToken|getAuth|currentUser""")),
    ("custom_guard", re.compile(r"""requireAuth|withAuth|authMiddleware|ProtectedRoute|protectRoute""")),
    ("auth_redirect", re.compile(r"""(?:redirect|push)\s*\(\s*['"]/(?:login|signin|auth)""")),
]


def read_text_safe(file_path: Path) -> str:
    """Read file content with UTF-8 encoding or replacement fallback."""
    try:
        return file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def detect_use_directive(content: str, directive: str) -> bool:
    """Detect whether a top-level use directive exists in the source text."""
    prefix = content[:1000]
    pattern = rf"""^[\s]*['"]use\s+{directive}['"]"""
    return bool(re.search(pattern, prefix, flags=re.MULTILINE))


def detect_server_action(content: str) -> bool:
    """Detect whether file contains server action directives or imports."""
    if detect_use_directive(content, "server"):
        return True
    if re.search(r"""['"]use\s+server['"]""", content):
        return True
    if re.search(r"""from\s+['"][^'"]*actions['"]""", content):
        return True
    return False


def extract_roles(content: str) -> List[str]:
    """Extract distinct roles checked in code."""
    found: Set[str] = set()
    for pat in ROLE_PATTERNS:
        for match in pat.finditer(content):
            role_name = match.group(1).strip()
            if role_name and len(role_name) <= 30:
                found.add(role_name)

    for match in ARRAY_ROLE_PATTERN.finditer(content):
        array_body = match.group(1)
        literals = re.findall(r"""['"]([a-zA-Z0-9_\-]+)['"]""", array_body)
        for r in literals:
            if r and len(r) <= 30:
                found.add(r)

    return sorted(found)


def extract_auth_signals(content: str) -> List[str]:
    """Extract distinct authentication signals found in code."""
    signals: List[str] = []
    for label, pattern in AUTH_SIGNALS:
        if pattern.search(content):
            signals.append(label)
    return signals


def extract_http_methods(content: str) -> List[str]:
    """Extract exported HTTP handler functions from route handler files."""
    methods: List[str] = []
    for method in HTTP_METHODS:
        pattern = rf"""export\s+(?:async\s+)?function\s+{method}\b"""
        if re.search(pattern, content):
            methods.append(method)
    return methods


def detect_intercepting_segment(segment: str) -> Tuple[bool, Optional[str], Optional[str]]:
    """Detect intercepting route markers in a segment path."""
    markers = [("(..)(..)", 8), ("(...)", 5), ("(..)", 4), ("(.)", 3)]
    for marker, marker_len in markers:
        if segment.startswith(marker):
            clean_name = segment[marker_len:]
            return True, marker, clean_name
    return False, None, None


def parse_app_route_metadata(relative_dir: Path) -> Dict[str, Any]:
    """Convert App Router folder hierarchy into URL route path and routing metadata."""
    parts = relative_dir.parts
    route_parts: List[str] = []
    route_groups: List[str] = []
    parallel_slot: Optional[str] = None
    is_intercepting = False
    intercepting_type: Optional[str] = None
    intercepted_target: Optional[str] = None

    for part in parts:
        # Route groups (group)
        if part.startswith("(") and part.endswith(")") and not (part.startswith("(.)") or part.startswith("(..)") or part.startswith("((.)") or part.startswith("(...)")):
            route_groups.append(part)
            continue

        # Parallel route slots @slot
        if part.startswith("@"):
            parallel_slot = part
            continue

        # Intercepting routes
        intercept_match, int_type, int_target = detect_intercepting_segment(part)
        if intercept_match:
            is_intercepting = True
            intercepting_type = int_type
            intercepted_target = int_target
            if int_target:
                route_parts.append(int_target)
            continue

        route_parts.append(part)

    if not route_parts:
        route_path = "/"
    else:
        route_path = "/" + "/".join(route_parts)

    return {
        "route_path": route_path,
        "route_groups": route_groups,
        "is_parallel_slot": parallel_slot is not None,
        "parallel_slot": parallel_slot,
        "is_intercepting": is_intercepting,
        "intercepting_type": intercepting_type,
        "intercepted_target": intercepted_target,
    }


def extract_dynamic_params(route_path: str) -> List[str]:
    """Find dynamic parameters like [id], [...slug], or [[...slug]]."""
    matches = re.findall(r"""\[(\.{0,3}[a-zA-Z0-9_\-]+)\]""", route_path)
    return matches


def scan_middleware(repo_root: Path) -> Optional[Dict[str, Any]]:
    """Detect and inspect middleware.ts or middleware.js in the repository."""
    candidates = [
        repo_root / "middleware.ts",
        repo_root / "middleware.js",
        repo_root / "src" / "middleware.ts",
        repo_root / "src" / "middleware.js",
    ]
    for cand in candidates:
        if cand.is_file():
            content = read_text_safe(cand)
            matchers: List[str] = []
            matcher_regex = re.compile(r"""matcher\s*:\s*(?:\[(.*?)\]|['"]([^'"]+)['"])""", re.DOTALL)
            m = matcher_regex.search(content)
            if m:
                if m.group(1):
                    raw_items = m.group(1).split(",")
                    for it in raw_items:
                        clean_item = it.strip().strip("'\"")
                        if clean_item:
                            matchers.append(clean_item)
                elif m.group(2):
                    matchers.append(m.group(2).strip())

            auth_present = bool(
                re.search(r"""token|auth|session|NextResponse\.redirect|NextResponse\.rewrite""", content, re.IGNORECASE)
            )
            return {
                "present": True,
                "file_path": str(cand.relative_to(repo_root)).replace("\\", "/"),
                "matcher": matchers,
                "auth_checks": auth_present,
                "roles_detected": extract_roles(content),
            }
    return None


def resolve_layout_chain(app_dir: Path, folder: Path, repo_root: Path) -> List[str]:
    """Resolve layout inheritance chain from root app directory down to page folder."""
    chain: List[str] = []
    # Collect directories from folder up to app_dir
    current = folder
    dir_list: List[Path] = []
    while True:
        dir_list.append(current)
        if current == app_dir or app_dir not in current.parents:
            break
        current = current.parent

    # Traverse from root to leaf
    for d in reversed(dir_list):
        for name in LAYOUT_FILENAMES:
            candidate = d / name
            if candidate.is_file():
                rel_path = str(candidate.relative_to(repo_root)).replace("\\", "/")
                if rel_path not in chain:
                    chain.append(rel_path)
                break
    return chain


def resolve_error_boundaries(app_dir: Path, folder: Path, repo_root: Path) -> Dict[str, Any]:
    """Resolve error boundaries, global error, and not-found templates in hierarchy."""
    error_list: List[str] = []
    has_global_error = False
    has_not_found = False

    # Check for global error in app root
    for name in GLOBAL_ERROR_FILENAMES:
        if (app_dir / name).is_file():
            has_global_error = True
            error_list.append(str((app_dir / name).relative_to(repo_root)).replace("\\", "/"))
            break

    # Traverse directories from folder up to app_dir
    current = folder
    dir_list: List[Path] = []
    while True:
        dir_list.append(current)
        if current == app_dir or app_dir not in current.parents:
            break
        current = current.parent

    for d in reversed(dir_list):
        for name in ERROR_FILENAMES:
            candidate = d / name
            if candidate.is_file():
                rel = str(candidate.relative_to(repo_root)).replace("\\", "/")
                if rel not in error_list:
                    error_list.append(rel)
                break
        for name in NOT_FOUND_FILENAMES:
            candidate = d / name
            if candidate.is_file():
                has_not_found = True
                rel = str(candidate.relative_to(repo_root)).replace("\\", "/")
                if rel not in error_list:
                    error_list.append(rel)
                break

    return {
        "error_boundaries": error_list,
        "has_error_boundary": len(error_list) > 0,
        "has_global_error": has_global_error,
        "has_not_found": has_not_found,
    }


def scan_app_router(repo_root: Path, app_dir: Path) -> List[Dict[str, Any]]:
    """Scan Next.js App Router directory tree for pages and route handlers."""
    routes: List[Dict[str, Any]] = []

    has_root_layout = any((app_dir / name).is_file() for name in LAYOUT_FILENAMES)

    for entry in app_dir.rglob("*"):
        if not entry.is_file():
            continue
        if entry.name not in (PAGE_FILENAMES | HANDLER_FILENAMES):
            continue

        relative_file = entry.relative_to(repo_root)
        folder = entry.parent
        relative_folder = folder.relative_to(app_dir)
        meta = parse_app_route_metadata(relative_folder)
        route_path = meta["route_path"]
        content = read_text_safe(entry)

        is_page = entry.name in PAGE_FILENAMES
        is_handler = entry.name in HANDLER_FILENAMES
        is_client = detect_use_directive(content, "client")
        is_server_action = detect_server_action(content)

        dynamic_params = extract_dynamic_params(route_path)
        roles = extract_roles(content)
        signals = extract_auth_signals(content)
        http_methods = extract_http_methods(content) if is_handler else []

        layout_chain = resolve_layout_chain(app_dir, folder, repo_root)
        error_info = resolve_error_boundaries(app_dir, folder, repo_root)

        parent_dirs = [folder] + list(folder.parents)
        has_loading = any(
            any((d / name).is_file() for name in LOADING_FILENAMES)
            for d in parent_dirs
            if app_dir in d.parents or d == app_dir
        )

        auth_required = bool(roles or signals)

        routes.append({
            "route": route_path,
            "file_path": str(relative_file).replace("\\", "/"),
            "router": "app",
            "type": "page" if is_page else "route_handler",
            "is_dynamic": len(dynamic_params) > 0,
            "dynamic_params": dynamic_params,
            "route_groups": meta["route_groups"],
            "is_parallel_slot": meta["is_parallel_slot"],
            "parallel_slot": meta["parallel_slot"],
            "is_intercepting": meta["is_intercepting"],
            "intercepting_type": meta["intercepting_type"],
            "intercepted_target": meta["intercepted_target"],
            "component_type": "client" if is_client else "server",
            "has_server_actions": is_server_action,
            "http_methods": http_methods,
            "has_layout": len(layout_chain) > 0,
            "layout_chain": layout_chain,
            "has_root_layout": has_root_layout,
            "has_error_boundary": error_info["has_error_boundary"],
            "error_boundaries": error_info["error_boundaries"],
            "has_global_error": error_info["has_global_error"],
            "has_not_found": error_info["has_not_found"],
            "has_loading_ui": has_loading,
            "auth_required": auth_required,
            "auth_signals": signals,
            "roles_required": roles,
        })

    return routes


def scan_pages_router(repo_root: Path, pages_dir: Path) -> List[Dict[str, Any]]:
    """Scan Next.js Pages Router directory tree for pages and API endpoints."""
    routes: List[Dict[str, Any]] = []

    for entry in pages_dir.rglob("*"):
        if not entry.is_file():
            continue
        if entry.suffix not in ROUTE_EXTENSIONS:
            continue
        if entry.name.startswith("_"):
            continue

        relative_file = entry.relative_to(repo_root)
        rel_from_pages = entry.relative_to(pages_dir)

        path_stem = rel_from_pages.with_suffix("")
        parts = list(path_stem.parts)

        is_api = len(parts) > 0 and parts[0] == "api"

        if parts[-1] == "index":
            parts.pop()

        if not parts:
            route_path = "/"
        else:
            route_path = "/" + "/".join(parts)

        content = read_text_safe(entry)
        dynamic_params = extract_dynamic_params(route_path)
        roles = extract_roles(content)
        signals = extract_auth_signals(content)
        auth_required = bool(roles or signals)

        routes.append({
            "route": route_path,
            "file_path": str(relative_file).replace("\\", "/"),
            "router": "pages",
            "type": "api_route" if is_api else "page",
            "is_dynamic": len(dynamic_params) > 0,
            "dynamic_params": dynamic_params,
            "route_groups": [],
            "is_parallel_slot": False,
            "parallel_slot": None,
            "is_intercepting": False,
            "intercepting_type": None,
            "intercepted_target": None,
            "component_type": "client",
            "has_server_actions": False,
            "http_methods": [],
            "has_layout": False,
            "layout_chain": [],
            "has_root_layout": False,
            "has_error_boundary": False,
            "error_boundaries": [],
            "has_global_error": False,
            "has_not_found": False,
            "has_loading_ui": False,
            "auth_required": auth_required,
            "auth_signals": signals,
            "roles_required": roles,
        })

    return routes


def scan_nextjs_routes(repo_path: Path) -> Dict[str, Any]:
    """Scan a target Next.js repository and generate route inventory."""
    resolved_repo = repo_path.resolve()
    if not resolved_repo.exists() or not resolved_repo.is_dir():
        raise ValueError(f"Target repository directory does not exist: {resolved_repo}")

    app_candidates = [resolved_repo / "app", resolved_repo / "src" / "app"]
    pages_candidates = [resolved_repo / "pages", resolved_repo / "src" / "pages"]

    app_dirs = [d for d in app_candidates if d.is_dir()]
    pages_dirs = [d for d in pages_candidates if d.is_dir()]

    router_types: List[str] = []
    routes: List[Dict[str, Any]] = []

    for app_dir in app_dirs:
        router_types.append("app")
        routes.extend(scan_app_router(resolved_repo, app_dir))

    for pages_dir in pages_dirs:
        router_types.append("pages")
        routes.extend(scan_pages_router(resolved_repo, pages_dir))

    routes.sort(key=lambda r: (r["router"], r["route"]))

    middleware_info = scan_middleware(resolved_repo)

    # Collect total unique error boundary files
    all_error_files: Set[str] = set()
    for r in routes:
        for eb in r.get("error_boundaries", []):
            all_error_files.add(eb)

    summary = {
        "total_routes": len(routes),
        "page_routes": sum(1 for r in routes if r["type"] == "page"),
        "api_routes": sum(1 for r in routes if r["type"] in ("route_handler", "api_route")),
        "dynamic_routes": sum(1 for r in routes if r["is_dynamic"]),
        "parallel_routes": sum(1 for r in routes if r.get("is_parallel_slot")),
        "intercepting_routes": sum(1 for r in routes if r.get("is_intercepting")),
        "client_components": sum(1 for r in routes if r["component_type"] == "client"),
        "server_components": sum(1 for r in routes if r["component_type"] == "server"),
        "server_actions": sum(1 for r in routes if r["has_server_actions"]),
        "error_boundaries_count": len(all_error_files),
        "middleware_present": middleware_info is not None,
        "protected_routes": sum(1 for r in routes if r["auth_required"]),
    }

    return {
        "scanner": "scan_nextjs_routes.py",
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "repo_path": str(resolved_repo).replace("\\", "/"),
        "router_types_detected": sorted(list(set(router_types))),
        "summary": summary,
        "middleware": middleware_info,
        "routes": routes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Scan Next.js repository routes and authorization checks.")
    parser.add_argument("--repo-path", required=True, type=Path, help="Path to target Next.js repository.")
    parser.add_argument("--output", type=Path, default=Path("nextjs_routes_inventory.json"), help="Output JSON path.")
    args = parser.parse_args()

    inventory = scan_nextjs_routes(args.repo_path)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(inventory, f, indent=2)

    print(f"Scanned {inventory['summary']['total_routes']} routes. Output saved to {args.output}")


if __name__ == "__main__":
    main()
