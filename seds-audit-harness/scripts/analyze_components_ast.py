"""Next.js Component AST and Dependency Graph Analyzer.

This script parses Next.js component trees, extracts JSX hierarchies,
inspects form elements and CAD upload dropzones, detects unreferenced
components, and constructs directed dependency graphs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

TARGET_EXTENSIONS = {".tsx", ".ts", ".jsx", ".js"}
EXCLUDE_DIRS = {
    "node_modules",
    ".next",
    ".git",
    "dist",
    "build",
    "coverage",
    ".turbo",
    ".vercel",
}

CAD_EXTENSIONS = {
    ".step",
    ".stp",
    ".iges",
    ".stl",
    ".dxf",
    ".sldprt",
    ".zip",
}

# Regex patterns for imports
IMPORT_STATIC_REGEX = re.compile(
    r"""import\s+(?:type\s+)?(?:(?P<default>[a-zA-Z0-9_$]+)\s*,?\s*)?(?:\{\s*(?P<named>[^}]+)\s*\}\s*)?(?:\*\s+as\s+(?P<namespace>[a-zA-Z0-9_$]+)\s*)?(?:from\s*)?['"](?P<source>[^'"]+)['"]""",
    re.MULTILINE,
)

IMPORT_DYNAMIC_REGEX = re.compile(
    r"""(?:import|require)\s*\(\s*['"](?P<source>[^'"]+)['"]\s*\)"""
)

# Regex patterns for exports
EXPORT_DEFAULT_REGEX = re.compile(
    r"""export\s+default\s+(?:function\s*(?P<fn>[a-zA-Z0-9_$]*)|class\s*(?P<cls>[a-zA-Z0-9_$]*)|(?P<ident>[a-zA-Z0-9_$]+))"""
)

EXPORT_NAMED_REGEX = re.compile(
    r"""export\s+(?:async\s+)?(?:function\s+(?P<fn>[a-zA-Z0-9_$]+)|const\s+(?P<cn>[a-zA-Z0-9_$]+)|let\s+(?P<lt>[a-zA-Z0-9_$]+)|class\s+(?P<cls>[a-zA-Z0-9_$]+)|type\s+(?P<tp>[a-zA-Z0-9_$]+)|interface\s+(?P<iface>[a-zA-Z0-9_$]+)|\{\s*(?P<items>[^}]+)\s*\})"""
)

# Regex patterns for JSX and components
JSX_TAG_REGEX = re.compile(
    r"""<([A-Z][a-zA-Z0-9_$]*|[a-z][a-z0-9_-]*)\b([^>]*?)(?:/?>|>)""",
    re.DOTALL,
)

INPUT_TAG_REGEX = re.compile(
    r"""<input\b([^>]*?)/?>""",
    re.IGNORECASE | re.DOTALL,
)

FORM_TAG_REGEX = re.compile(
    r"""<form\b([^>]*?)(?:/?>|>)""",
    re.IGNORECASE | re.DOTALL,
)

DROPZONE_SIGNALS = [
    re.compile(r"""useDropzone\s*\("""),
    re.compile(r"""<Dropzone\b""", re.IGNORECASE),
    re.compile(r"""<UploadDropzone\b""", re.IGNORECASE),
    re.compile(r"""<FileDropzone\b""", re.IGNORECASE),
    re.compile(r"""onDrop\s*[:=]"""),
    re.compile(r"""onDragOver\s*[:=]"""),
]

UPLOAD_HANDLER_SIGNALS = [
    re.compile(r"""uploadBytes\s*\("""),
    re.compile(r"""uploadBytesResumable\s*\("""),
    re.compile(r"""getStorage\s*\("""),
    re.compile(r"""ref\s*\(\s*storage"""),
    re.compile(r"""new\s+FormData\s*\("""),
    re.compile(r"""new\s+FileReader\s*\("""),
    re.compile(r"""readAsDataURL\s*\("""),
    re.compile(r"""readAsArrayBuffer\s*\("""),
]

FORM_LIBRARY_SIGNALS = [
    re.compile(r"""useForm\s*(?:<[^>]+>)?\s*\("""),
    re.compile(r"""zodResolver\s*\("""),
    re.compile(r"""yupResolver\s*\("""),
    re.compile(r"""handleSubmit\s*\("""),
]

FIRESTORE_CALL_REGEX = re.compile(
    r"""(?:collection|doc)\s*\(\s*(?:[a-zA-Z0-9_$]+)\s*,\s*['"]([a-zA-Z0-9_/-]+)['"]"""
)

FIRESTORE_OPS_REGEX = re.compile(
    r"""\b(addDoc|setDoc|updateDoc|getDocs|getDoc|deleteDoc|onSnapshot)\s*\("""
)


def read_file_safe(path: Path) -> str:
    """Read text from file with fallback encoding."""
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def load_path_aliases(repo_root: Path) -> Dict[str, List[str]]:
    """Parse tsconfig.json or jsconfig.json to discover import path aliases."""
    for config_name in ["tsconfig.json", "jsconfig.json"]:
        config_path = repo_root / config_name
        if config_path.is_file():
            try:
                raw_text = read_file_safe(config_path)
                # Strip comments
                no_single = re.sub(r"//.*", "", raw_text)
                no_comments = re.sub(r"/\*.*?\*/", "", no_single, flags=re.DOTALL)
                parsed = json.loads(no_comments)
                compiler_opts = parsed.get("compilerOptions", {})
                paths = compiler_opts.get("paths", {})
                base_url = compiler_opts.get("baseUrl", ".")
                resolved_aliases: Dict[str, List[str]] = {}
                for alias_pat, target_pats in paths.items():
                    clean_alias = alias_pat.rstrip("*")
                    clean_targets = [t.rstrip("*") for t in target_pats]
                    target_dirs: List[str] = []
                    for t in clean_targets:
                        combined = Path(base_url) / t
                        target_dirs.append(str(combined).replace("\\", "/").rstrip("/") + "/")
                    resolved_aliases[clean_alias] = target_dirs
                if resolved_aliases:
                    return resolved_aliases
            except Exception:
                pass

    # Built-in fallbacks
    return {
        "@/": ["src/", "./"],
        "~/": ["src/", "./"],
        "@components/": ["components/", "src/components/"],
        "@lib/": ["lib/", "src/lib/"],
    }


def resolve_import_path(
    source_str: str,
    importer_file: Path,
    repo_root: Path,
    aliases: Dict[str, List[str]],
) -> Tuple[Optional[Path], bool]:
    """Resolve import path string to file path on disk or mark as external."""
    clean_source = source_str.strip()
    if not clean_source:
        return None, False

    # Relative import
    if clean_source.startswith("."):
        candidate_base = (importer_file.parent / clean_source).resolve()
        resolved = check_file_extensions(candidate_base)
        if resolved and is_within_repo(resolved, repo_root):
            return resolved, False
        return None, False

    # Alias import
    for alias_prefix, target_dirs in aliases.items():
        if clean_source.startswith(alias_prefix):
            remainder = clean_source[len(alias_prefix):]
            for target_dir in target_dirs:
                candidate_base = (repo_root / target_dir / remainder).resolve()
                resolved = check_file_extensions(candidate_base)
                if resolved and is_within_repo(resolved, repo_root):
                    return resolved, False

    # Root-relative check
    candidate_root = (repo_root / clean_source).resolve()
    resolved = check_file_extensions(candidate_root)
    if resolved and is_within_repo(resolved, repo_root):
        return resolved, False

    # Not found in repository source tree, classify as external package
    return None, True


def check_file_extensions(base_path: Path) -> Optional[Path]:
    """Test candidate extensions and index files."""
    if base_path.is_file():
        return base_path

    for ext in TARGET_EXTENSIONS:
        direct = base_path.with_suffix(ext)
        if direct.is_file():
            return direct

    if base_path.is_dir():
        for ext in TARGET_EXTENSIONS:
            index_path = base_path / f"index{ext}"
            if index_path.is_file():
                return index_path

    return None


def is_within_repo(target_path: Path, repo_root: Path) -> bool:
    """Check if target path resides within repository root."""
    try:
        target_path.relative_to(repo_root)
        return True
    except ValueError:
        return False


def parse_source_file_ast(file_path: Path, repo_root: Path, aliases: Dict[str, List[str]]) -> Dict[str, Any]:
    """Parse one TypeScript/JavaScript file for imports, exports, JSX, and form elements."""
    rel_path_str = str(file_path.relative_to(repo_root)).replace("\\", "/")
    content = read_file_safe(file_path)

    # Directives
    is_client = bool(re.search(r"""^[\s'"]*use client['"]""", content, re.MULTILINE))
    is_server = bool(re.search(r"""^[\s'"]*use server['"]""", content, re.MULTILINE))

    # Imports
    imports_internal: List[Dict[str, Any]] = []
    imports_external: List[Dict[str, Any]] = []

    # Static imports
    for match in IMPORT_STATIC_REGEX.finditer(content):
        source_mod = match.group("source")
        default_sym = match.group("default")
        named_str = match.group("named")
        namespace_sym = match.group("namespace")

        symbols: List[str] = []
        if default_sym:
            symbols.append(default_sym.strip())
        if namespace_sym:
            symbols.append(namespace_sym.strip())
        if named_str:
            for item in named_str.split(","):
                clean_item = item.strip()
                if clean_item.startswith("type "):
                    clean_item = clean_item[5:].strip()
                if " as " in clean_item:
                    orig_part, alias_part = clean_item.split(" as ", 1)
                    symbols.append(alias_part.strip())
                    symbols.append(orig_part.strip())
                elif clean_item:
                    symbols.append(clean_item)

        resolved_file, is_ext = resolve_import_path(source_mod, file_path, repo_root, aliases)
        if resolved_file:
            rel_target = str(resolved_file.relative_to(repo_root)).replace("\\", "/")
            imports_internal.append({
                "source": source_mod,
                "target_file": rel_target,
                "symbols": symbols,
                "is_default": bool(default_sym),
                "is_dynamic": False,
            })
        elif is_ext:
            imports_external.append({
                "package": source_mod,
                "symbols": symbols,
                "is_dynamic": False,
            })

    # Dynamic imports
    for match in IMPORT_DYNAMIC_REGEX.finditer(content):
        source_mod = match.group("source")
        resolved_file, is_ext = resolve_import_path(source_mod, file_path, repo_root, aliases)
        if resolved_file:
            rel_target = str(resolved_file.relative_to(repo_root)).replace("\\", "/")
            imports_internal.append({
                "source": source_mod,
                "target_file": rel_target,
                "symbols": [],
                "is_dynamic": True,
            })
        elif is_ext:
            imports_external.append({
                "package": source_mod,
                "symbols": [],
                "is_dynamic": True,
            })

    # Exports
    exports: List[str] = []
    default_export: Optional[str] = None

    for match in EXPORT_DEFAULT_REGEX.finditer(content):
        ident = match.group("fn") or match.group("cls") or match.group("ident")
        if ident:
            default_export = ident.strip()
            exports.append(default_export)
        else:
            default_export = Path(file_path).stem
            exports.append(default_export)

    for match in EXPORT_NAMED_REGEX.finditer(content):
        for group_name in ["fn", "cn", "lt", "cls", "tp", "iface"]:
            val = match.group(group_name)
            if val:
                exports.append(val.strip())
        items_str = match.group("items")
        if items_str:
            for it in items_str.split(","):
                clean_it = it.strip()
                if " as " in clean_it:
                    clean_it = clean_it.split(" as ")[1].strip()
                if clean_it:
                    exports.append(clean_it)

    # JSX tags
    rendered_tags: Set[str] = set()
    child_components: Set[str] = set()
    for match in JSX_TAG_REGEX.finditer(content):
        tag = match.group(1)
        rendered_tags.add(tag)
        if tag[0].isupper():
            child_components.add(tag)

    # Form analysis
    form_inputs: List[Dict[str, Any]] = []
    has_form = bool(FORM_TAG_REGEX.search(content)) or any(p.search(content) for p in FORM_LIBRARY_SIGNALS)

    for match in INPUT_TAG_REGEX.finditer(content):
        attrs_str = match.group(1)
        type_match = re.search(r"""type=['"]([^'"]+)['"]""", attrs_str, re.IGNORECASE)
        accept_match = re.search(r"""accept=['"]([^'"]+)['"]""", attrs_str, re.IGNORECASE)
        name_match = re.search(r"""name=['"]([^'"]+)['"]""", attrs_str, re.IGNORECASE)

        input_type = type_match.group(1).lower() if type_match else "text"
        accept_val = accept_match.group(1).lower() if accept_match else ""
        name_val = name_match.group(1) if name_match else ""

        input_entry: Dict[str, Any] = {
            "tag": "input",
            "type": input_type,
            "name": name_val,
            "accept": accept_val,
        }

        # Check for CAD extensions in accept
        matched_cad = [ext for ext in CAD_EXTENSIONS if ext in accept_val]
        if matched_cad:
            input_entry["cad_extensions"] = matched_cad

        form_inputs.append(input_entry)

    # Dropzone detection
    has_dropzone = any(p.search(content) for p in DROPZONE_SIGNALS)
    detected_cad_in_file = set()
    content_lower = content.lower()
    for cad_ext in CAD_EXTENSIONS:
        if cad_ext in content_lower:
            detected_cad_in_file.add(cad_ext)

    # File upload handling
    has_file_upload = any(p.search(content) for p in UPLOAD_HANDLER_SIGNALS) or any(
        inp["type"] == "file" for inp in form_inputs
    )

    # Firestore usage
    firestore_collections = sorted(list(set(FIRESTORE_CALL_REGEX.findall(content))))
    firestore_ops = sorted(list(set(FIRESTORE_OPS_REGEX.findall(content))))

    # File role classification
    file_type = classify_file_role(rel_path_str)

    return {
        "file_path": rel_path_str,
        "name": Path(file_path).stem,
        "size_bytes": file_path.stat().st_size,
        "file_type": file_type,
        "is_client": is_client,
        "is_server": is_server,
        "default_export": default_export,
        "exports": sorted(list(set(exports))),
        "imports_internal": imports_internal,
        "imports_external": imports_external,
        "rendered_tags": sorted(list(rendered_tags)),
        "child_components": sorted(list(child_components)),
        "has_form": has_form,
        "form_inputs": form_inputs,
        "has_dropzone": has_dropzone,
        "has_file_upload": has_file_upload,
        "cad_extensions": sorted(list(detected_cad_in_file)),
        "firestore_collections": firestore_collections,
        "firestore_operations": firestore_ops,
    }


def classify_file_role(rel_path: str) -> str:
    """Classify the functional role of a source file."""
    norm = rel_path.replace("\\", "/").lower()
    if "/page." in norm or norm.startswith("pages/") or norm.startswith("src/pages/"):
        return "route"
    if "/route." in norm or "/api/" in norm:
        return "route_handler"
    if "/layout." in norm:
        return "layout"
    if "/loading." in norm:
        return "loading"
    if "/error." in norm or "/global-error." in norm:
        return "error_boundary"
    if "component" in norm:
        return "component"
    if "hook" in norm:
        return "hook"
    if "lib" in norm or "util" in norm:
        return "utility"
    return "module"


def build_component_tree(
    root_file: str,
    file_catalog: Dict[str, Dict[str, Any]],
    export_to_file: Dict[str, str],
    visited_branch: Optional[Set[str]] = None,
    current_depth: int = 1,
    max_depth_limit: int = 30,
) -> Dict[str, Any]:
    """Construct child component tree by recursion starting from route file."""
    if visited_branch is None:
        visited_branch = set()

    file_info = file_catalog.get(root_file, {})
    tree_node: Dict[str, Any] = {
        "file_path": root_file,
        "name": file_info.get("name", Path(root_file).stem),
        "component_name": file_info.get("default_export") or file_info.get("name", ""),
        "is_client": file_info.get("is_client", False),
        "depth": current_depth,
        "has_form": file_info.get("has_form", False),
        "has_dropzone": file_info.get("has_dropzone", False),
        "has_file_upload": file_info.get("has_file_upload", False),
        "cad_extensions": file_info.get("cad_extensions", []),
        "firestore_collections": file_info.get("firestore_collections", []),
        "form_inputs": file_info.get("form_inputs", []),
        "children": [],
    }

    if root_file in visited_branch:
        return tree_node

    if current_depth >= max_depth_limit:
        tree_node["truncated_depth"] = True
        sys.stderr.write(
            f"[WARN] Component tree depth limit ({max_depth_limit}) reached at {root_file}. Subtree truncated.\n"
        )
        return tree_node

    branch_set = set(visited_branch)
    branch_set.add(root_file)

    # Collect internal imports from this file with their imported symbols
    internal_targets: Dict[str, Set[str]] = defaultdict(set)
    for imp in file_info.get("imports_internal", []):
        target = imp.get("target_file")
        if target and target in file_catalog:
            for s in imp.get("symbols", []):
                if s:
                    internal_targets[target].add(s)
            if target not in internal_targets:
                internal_targets[target] = set()

    # Identify which child components match rendered tags
    rendered_tags = set(file_info.get("child_components", []))

    for target_file in sorted(list(internal_targets.keys())):
        target_info = file_catalog.get(target_file, {})
        target_exports = set(target_info.get("exports", []))
        if target_info.get("default_export"):
            target_exports.add(target_info["default_export"])

        imported_symbols = internal_targets[target_file]

        # Match if rendered tags intersect target exports OR imported local aliases
        if (
            rendered_tags.intersection(target_exports)
            or rendered_tags.intersection(imported_symbols)
            or not rendered_tags
        ):
            child_tree = build_component_tree(
                target_file,
                file_catalog,
                export_to_file,
                branch_set,
                current_depth + 1,
                max_depth_limit,
            )
            tree_node["children"].append(child_tree)

    return tree_node


def aggregate_tree_metrics(node: Dict[str, Any]) -> Dict[str, Any]:
    """Aggregate metrics across a component tree node and its descendants."""
    cad_set: Set[str] = set(node.get("cad_extensions", []))
    collections_set: Set[str] = set(node.get("firestore_collections", []))
    has_form = node.get("has_form", False)
    has_dropzone = node.get("has_dropzone", False)
    has_file_upload = node.get("has_file_upload", False)
    client_nodes = [node["file_path"]] if node.get("is_client") else []
    max_d = node.get("depth", 1)
    child_files: Set[str] = set()

    for child in node.get("children", []):
        child_metrics = aggregate_tree_metrics(child)
        cad_set.update(child_metrics["cad_extensions"])
        collections_set.update(child_metrics["bound_collections"])
        has_form = has_form or child_metrics["has_form"]
        has_dropzone = has_dropzone or child_metrics["has_dropzone"]
        has_file_upload = has_file_upload or child_metrics["has_file_upload"]
        client_nodes.extend(child_metrics["client_components"])
        child_files.add(child["file_path"])
        child_files.update(child_metrics["all_child_files"])
        if child_metrics["max_depth"] > max_d:
            max_d = child_metrics["max_depth"]

    return {
        "max_depth": max_d,
        "total_child_components": len(child_files),
        "all_child_files": sorted(list(child_files)),
        "has_form": has_form,
        "has_dropzone": has_dropzone,
        "has_cad_dropzone": has_dropzone or bool(cad_set),
        "has_file_upload": has_file_upload,
        "cad_extensions": sorted(list(cad_set)),
        "bound_collections": sorted(list(collections_set)),
        "client_components": sorted(list(set(client_nodes))),
    }


def find_graph_cycles(adjacency: Dict[str, Set[str]]) -> List[List[str]]:
    """Detect circular dependency cycles using depth-first search."""
    cycles: List[List[str]] = []
    # 0 = unvisited, 1 = visiting, 2 = visited
    state: Dict[str, int] = {node: 0 for node in adjacency}
    path: List[str] = []

    def dfs(u: str) -> None:
        state[u] = 1
        path.append(u)
        for v in sorted(adjacency.get(u, set())):
            if v not in state:
                continue
            if state[v] == 1:
                # Cycle found
                cycle_start = path.index(v)
                cycle = path[cycle_start:] + [v]
                cycles.append(cycle)
            elif state[v] == 0:
                dfs(v)
        path.pop()
        state[u] = 2

    for node in sorted(adjacency.keys()):
        if state[node] == 0:
            dfs(node)

    return cycles


def compute_route_reachability(route_files: List[str], adjacency: Dict[str, Set[str]]) -> Set[str]:
    """Compute all files reachable from route entry points via breadth-first search."""
    reachable: Set[str] = set(route_files)
    queue = deque(route_files)

    while queue:
        curr = queue.popleft()
        for neighbor in adjacency.get(curr, set()):
            if neighbor not in reachable:
                reachable.add(neighbor)
                queue.append(neighbor)

    return reachable


def scan_components_ast(
    repo_path: Path,
    output_tree_path: Optional[Path] = None,
    output_graph_path: Optional[Path] = None,
    verbose: bool = False,
    max_depth_limit: int = 30,
) -> Dict[str, Any]:
    """Execute full AST scanning across repository and construct tree and graph."""
    resolved_repo = repo_path.resolve()
    if not resolved_repo.exists():
        raise FileNotFoundError(f"Target repository path does not exist: {resolved_repo}")

    aliases = load_path_aliases(resolved_repo)
    if verbose:
        print(f"[INFO] Loaded {len(aliases)} path aliases from configuration.")

    # 1. Discover all candidate source files
    discovered_files: List[Path] = []
    for root, dirs, files in os.walk(resolved_repo):
        # Filter excluded directories in-place
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith(".")]
        for f in files:
            p = Path(root) / f
            if p.suffix in TARGET_EXTENSIONS and not f.endswith(".d.ts") and ".test." not in f and ".spec." not in f:
                discovered_files.append(p)

    if verbose:
        print(f"[INFO] Discovered {len(discovered_files)} source files.")

    # 2. Parse each file
    file_catalog: Dict[str, Dict[str, Any]] = {}
    export_to_file: Dict[str, str] = {}
    for fpath in discovered_files:
        parsed = parse_source_file_ast(fpath, resolved_repo, aliases)
        rel_key = parsed["file_path"]
        file_catalog[rel_key] = parsed
        for exp in parsed["exports"]:
            export_to_file[exp] = rel_key

    # 3. Construct Directed Graph
    adjacency: Dict[str, Set[str]] = defaultdict(set)
    in_degree: Dict[str, int] = defaultdict(int)
    out_degree: Dict[str, int] = defaultdict(int)
    edges: List[Dict[str, Any]] = []
    package_deps: Dict[str, Set[str]] = defaultdict(set)

    for src_file, data in file_catalog.items():
        # Ensure node is present in degrees
        in_degree[src_file] = in_degree.get(src_file, 0)
        out_degree[src_file] = out_degree.get(src_file, 0)

        for imp in data["imports_internal"]:
            tgt_file = imp["target_file"]
            if tgt_file in file_catalog:
                adjacency[src_file].add(tgt_file)
                edges.append({
                    "source": src_file,
                    "target": tgt_file,
                    "import_type": "dynamic" if imp.get("is_dynamic") else "static",
                    "symbols": imp.get("symbols", []),
                })
                out_degree[src_file] += 1
                in_degree[tgt_file] += 1

        for ext_imp in data["imports_external"]:
            pkg = ext_imp["package"]
            package_deps[pkg].add(src_file)

    # 4. Identify Route Entry Points and Root Entry Points
    route_files: List[str] = []
    entry_files: List[str] = []

    for fkey, fdata in file_catalog.items():
        norm_key = fkey.replace("\\", "/").lower()
        is_route = (
            fdata["file_type"] in ("route", "route_handler")
            or "/page." in norm_key
            or norm_key.startswith("pages/")
            or norm_key.startswith("src/pages/")
        )
        is_layout = fdata["file_type"] in ("layout", "loading", "error_boundary") or any(
            x in norm_key
            for x in [
                "/layout.",
                "/template.",
                "/loading.",
                "/error.",
                "/global-error.",
                "/not-found.",
            ]
        )
        is_root_config = norm_key in (
            "middleware.ts",
            "middleware.js",
            "instrumentation.ts",
            "instrumentation.js",
        ) or any(
            norm_key.startswith(p)
            for p in [
                "pages/_app",
                "pages/_document",
                "pages/_error",
                "src/pages/_app",
                "src/pages/_document",
                "src/pages/_error",
            ]
        )

        if is_route and not is_root_config:
            route_files.append(fkey)

        if is_route or is_layout or is_root_config:
            entry_files.append(fkey)

    route_files = sorted(list(set(route_files)))
    entry_files = sorted(list(set(entry_files)))
    reachable_from_routes = compute_route_reachability(entry_files, adjacency)

    # 5. Detect Unreferenced Components (Dead Components)
    dead_components: List[Dict[str, Any]] = []
    for fkey, fdata in file_catalog.items():
        norm_key = fkey.replace("\\", "/").lower()
        is_route = fkey in route_files
        is_layout = fdata["file_type"] in ("layout", "loading", "error_boundary") or any(
            x in norm_key
            for x in [
                "/layout.",
                "/template.",
                "/loading.",
                "/error.",
                "/global-error.",
                "/not-found.",
            ]
        )
        is_root_config = norm_key in (
            "middleware.ts",
            "middleware.js",
            "instrumentation.ts",
            "instrumentation.js",
        ) or any(
            norm_key.startswith(p)
            for p in [
                "pages/_app",
                "pages/_document",
                "pages/_error",
                "src/pages/_app",
                "src/pages/_document",
                "src/pages/_error",
            ]
        )

        if not is_route and not is_layout and not is_root_config:
            # Component or utility unreachable from any route or layout
            if fkey not in reachable_from_routes:
                dead_components.append({
                    "file_path": fkey,
                    "name": fdata["name"],
                    "file_type": fdata["file_type"],
                    "exports": fdata["exports"],
                    "size_bytes": fdata["size_bytes"],
                    "is_reachable_from_routes": False,
                })

    # 6. Detect Circular Dependencies
    cycles = find_graph_cycles(adjacency)

    # 7. Build Route Trees
    routes_tree: List[Dict[str, Any]] = []
    routes_with_cad = 0
    routes_with_forms = 0

    for r_file in route_files:
        r_info = file_catalog.get(r_file, {})
        # Derive route URL from path
        route_url = derive_route_url(r_file)
        tree_root = build_component_tree(
            r_file,
            file_catalog,
            export_to_file,
            max_depth_limit=max_depth_limit,
        )
        metrics = aggregate_tree_metrics(tree_root)

        if metrics["has_cad_dropzone"] or metrics["cad_extensions"]:
            routes_with_cad += 1
        if metrics["has_form"]:
            routes_with_forms += 1

        routes_tree.append({
            "route": route_url,
            "route_file": r_file,
            "component_name": r_info.get("default_export") or r_info.get("name", ""),
            "file_type": r_info.get("file_type", "route"),
            "is_client": r_info.get("is_client", False),
            "max_depth": metrics["max_depth"],
            "total_child_components": metrics["total_child_components"],
            "has_form": metrics["has_form"],
            "has_cad_dropzone": metrics["has_dropzone"] or bool(metrics["cad_extensions"]),
            "cad_extensions": metrics["cad_extensions"],
            "has_file_upload": metrics["has_file_upload"],
            "bound_collections": metrics["bound_collections"],
            "client_components": metrics["client_components"],
            "tree": tree_root,
        })

    # 8. Assemble Graph Nodes
    graph_nodes: List[Dict[str, Any]] = []
    for fkey, fdata in file_catalog.items():
        graph_nodes.append({
            "id": fkey,
            "label": fdata["name"],
            "type": fdata["file_type"],
            "is_client": fdata["is_client"],
            "in_degree": in_degree[fkey],
            "out_degree": out_degree[fkey],
            "has_form": fdata["has_form"],
            "has_cad_dropzone": fdata["has_dropzone"] or bool(fdata["cad_extensions"]),
            "has_file_upload": fdata["has_file_upload"],
            "is_reachable_from_routes": fkey in reachable_from_routes,
        })

    timestamp = datetime.now(timezone.utc).isoformat()

    tree_deliverable = {
        "scanner": "analyze_components_ast.py",
        "scanned_at": timestamp,
        "repo_path": str(resolved_repo).replace("\\", "/"),
        "summary": {
            "total_files_cataloged": len(file_catalog),
            "total_routes_analyzed": len(route_files),
            "routes_with_cad_dropzones": routes_with_cad,
            "routes_with_forms": routes_with_forms,
            "unreferenced_dead_components_count": len(dead_components),
            "total_client_components": sum(1 for f in file_catalog.values() if f["is_client"]),
            "total_server_components": sum(1 for f in file_catalog.values() if not f["is_client"]),
        },
        "routes_tree": routes_tree,
        "dead_components": dead_components,
    }

    package_deps_serializable = {pkg: sorted(list(files)) for pkg, files in package_deps.items()}

    graph_deliverable = {
        "scanner": "analyze_components_ast.py",
        "scanned_at": timestamp,
        "repo_path": str(resolved_repo).replace("\\", "/"),
        "summary": {
            "total_nodes": len(graph_nodes),
            "total_edges": len(edges),
            "external_packages_count": len(package_deps),
            "circular_dependencies_count": len(cycles),
            "unreferenced_components_count": len(dead_components),
        },
        "nodes": graph_nodes,
        "edges": edges,
        "circular_dependencies": cycles,
        "unreferenced_components": dead_components,
        "package_dependencies": package_deps_serializable,
    }

    # Save outputs if destinations provided
    if output_tree_path:
        output_tree_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_tree_path, "w", encoding="utf-8") as f:
            json.dump(tree_deliverable, f, indent=2)
        if verbose:
            print(f"[INFO] Component tree written to {output_tree_path}")

    if output_graph_path:
        output_graph_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_graph_path, "w", encoding="utf-8") as f:
            json.dump(graph_deliverable, f, indent=2)
        if verbose:
            print(f"[INFO] Dependency graph written to {output_graph_path}")

    return {
        "component_tree": tree_deliverable,
        "dependency_graph": graph_deliverable,
    }


def derive_route_url(file_path: str) -> str:
    """Derive public URL path from file path in App Router or Pages Router."""
    norm = file_path.replace("\\", "/")
    if norm.startswith("./"):
        norm = norm[2:]

    # Check for pages or app in path
    is_pages = False
    if "/src/pages/" in norm:
        is_pages = True
        part = norm.split("/src/pages/", 1)[1]
    elif "/pages/" in norm:
        is_pages = True
        part = norm.split("/pages/", 1)[1]
    elif norm.startswith("src/pages/"):
        is_pages = True
        part = norm[len("src/pages/"):]
    elif norm.startswith("pages/"):
        is_pages = True
        part = norm[len("pages/"):]
    elif "/src/app/" in norm:
        part = norm.split("/src/app/", 1)[1]
    elif "/app/" in norm:
        part = norm.split("/app/", 1)[1]
    elif norm.startswith("src/app/"):
        part = norm[len("src/app/"):]
    elif norm.startswith("app/"):
        part = norm[len("app/"):]
    else:
        part = norm

    if is_pages:
        # Pages router: file stem defines route segment unless named index
        p = Path(part)
        stem = p.stem
        parent_dir = str(p.parent).replace("\\", "/")
        if parent_dir == ".":
            return "/" if stem == "index" else f"/{stem}"
        else:
            return f"/{parent_dir}" if stem == "index" else f"/{parent_dir}/{stem}"
    else:
        # App router: directory structure defines route segment
        parent = str(Path(part).parent).replace("\\", "/")
        if parent == ".":
            parent = ""
        segments = [s for s in parent.split("/") if s and not (s.startswith("(") and s.endswith(")"))]
        url = "/" + "/".join(segments)
        return url or "/"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Analyze React and Next.js component ASTs, JSX trees, forms, and dependencies."
    )
    parser.add_argument("--repo-path", required=True, type=Path, help="Path to target Next.js repository.")
    parser.add_argument("--output-dir", type=Path, default=None, help="Directory to save output JSON files.")
    parser.add_argument("--output-tree", type=Path, default=None, help="Direct path to component_tree.json.")
    parser.add_argument("--output-graph", type=Path, default=None, help="Direct path to dependency_graph.json.")
    parser.add_argument("--verbose", action="store_true", help="Print verbose telemetry output.")
    parser.add_argument(
        "--max-depth",
        type=int,
        default=30,
        help="Maximum recursion depth for component tree traversal (default: 30).",
    )

    args = parser.parse_args()

    # Determine output destinations
    out_dir = args.output_dir
    tree_path = args.output_tree
    graph_path = args.output_graph

    if not tree_path and out_dir:
        tree_path = out_dir / "component_tree.json"
    elif not tree_path:
        tree_path = Path("component_tree.json")

    if not graph_path and out_dir:
        graph_path = out_dir / "dependency_graph.json"
    elif not graph_path:
        graph_path = Path("dependency_graph.json")

    results = scan_components_ast(
        repo_path=args.repo_path,
        output_tree_path=tree_path,
        output_graph_path=graph_path,
        verbose=args.verbose,
        max_depth_limit=args.max_depth,
    )

    tree_summary = results["component_tree"]["summary"]
    graph_summary = results["dependency_graph"]["summary"]

    print("==================================================")
    print("   COMPONENT AST AND DEPENDENCY GRAPH SUMMARY     ")
    print("==================================================")
    print(f"Files Cataloged:           {tree_summary['total_files_cataloged']}")
    print(f"Routes Analyzed:           {tree_summary['total_routes_analyzed']}")
    print(f"Routes with CAD Dropzones: {tree_summary['routes_with_cad_dropzones']}")
    print(f"Routes with Forms:         {tree_summary['routes_with_forms']}")
    print(f"Dead Components Detected:  {tree_summary['unreferenced_dead_components_count']}")
    print(f"Graph Nodes / Edges:       {graph_summary['total_nodes']} / {graph_summary['total_edges']}")
    print(f"Circular Cycles Detected:  {graph_summary['circular_dependencies_count']}")
    print("--------------------------------------------------")
    print(f"Component Tree JSON:       {tree_path}")
    print(f"Dependency Graph JSON:     {graph_path}")
    print("==================================================")


if __name__ == "__main__":
    main()
