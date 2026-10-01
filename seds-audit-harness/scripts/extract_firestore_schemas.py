"""Firestore Schema, Subcollection, and Security Rules Extractor.

This tool scans Next.js and Firebase codebases, extracts Firestore
collection and subcollection paths, parses TypeScript interfaces and Zod
validation schemas, captures client queries and mutation hooks, and maps
security conditions from firestore.rules files.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

CODE_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx"}

MODULAR_COLLECTION_REGEX = re.compile(
    r"""\bcollection\s*\(\s*(?:doc\s*\(([^)]+)\)\s*,\s*([^)]+)|\s*[^,]+\s*,\s*([^)]+))\)"""
)
COMPAT_COLLECTION_REGEX = re.compile(
    r"""\.(?:collection|collectionGroup)\s*\(\s*['"]([a-zA-Z0-9_\-/]+)['"]\s*\)"""
)

MODULAR_DOC_REGEX = re.compile(
    r"""\bdoc\s*\(\s*[^,]+,\s*([^)]+)\)"""
)
COMPAT_DOC_REGEX = re.compile(
    r"""\.doc\s*\(\s*['"]([a-zA-Z0-9_\-/]+)['"]"""
)

WHERE_REGEX = re.compile(
    r"""where\s*\(\s*['"]([a-zA-Z0-9_.]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)"""
)
ORDER_BY_REGEX = re.compile(
    r"""orderBy\s*\(\s*['"]([a-zA-Z0-9_.]+)['"](?:\s*,\s*['"](asc|desc)['"])?"""
)
LIMIT_REGEX = re.compile(
    r"""limit\s*\(\s*([0-9]+)\s*\)"""
)

DATA_FIELD_REGEX = re.compile(
    r"""(?:data\(\)|data)\.([a-zA-Z0-9_]+)"""
)

MUTATION_HOOK_REGEX = re.compile(
    r"""\b(useMutation|useQuery|useInfiniteQuery|useSWR|useSWRMutation|useCollection|useDocument|addDoc|setDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\s*(?:<[^>]+>)?\s*\("""
)


READ_OPERATIONS = {"getDocs", "getDoc", "onSnapshot", "get"}
WRITE_OPERATIONS = {"addDoc", "setDoc", "updateDoc", "deleteDoc", "set", "update", "delete", "add", "writeBatch", "runTransaction"}


def read_text_safe(file_path: Path) -> str:
    """Read file content with UTF-8 encoding or replacement fallback."""
    try:
        return file_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return file_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def extract_typescript_interfaces(content: str) -> Dict[str, List[Dict[str, Any]]]:
    """Extract TypeScript interfaces and type definitions with their fields."""
    interfaces: Dict[str, List[Dict[str, Any]]] = {}

    interface_pattern = re.compile(
        r"""(?:export\s+)?interface\s+([A-Za-z0-9_]+)(?:\s+extends\s+[^{]+)?\s*\{([^}]+)\}""",
        re.MULTILINE,
    )
    for match in interface_pattern.finditer(content):
        name = match.group(1)
        body = match.group(2)
        fields = parse_interface_fields(body)
        if fields:
            interfaces[name] = fields

    type_pattern = re.compile(
        r"""(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=\s*\{([^}]+)\}""",
        re.MULTILINE,
    )
    for match in type_pattern.finditer(content):
        name = match.group(1)
        body = match.group(2)
        fields = parse_interface_fields(body)
        if fields and name not in interfaces:
            interfaces[name] = fields

    return interfaces


def parse_interface_fields(body: str) -> List[Dict[str, Any]]:
    """Parse field declarations inside a TypeScript interface body."""
    fields: List[Dict[str, Any]] = []
    lines = body.split("\n")
    field_regex = re.compile(r"""^\s*([a-zA-Z0-9_]+)(\?)?\s*:\s*([^;,\n]+)""")

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
            continue
        m = field_regex.search(stripped)
        if m:
            field_name = m.group(1)
            optional = m.group(2) == "?"
            type_decl = m.group(3).strip().rstrip(";,")
            fields.append({
                "name": field_name,
                "type": type_decl,
                "optional": optional,
            })
    return fields


def extract_zod_schemas(content: str) -> Dict[str, Dict[str, Any]]:
    """Extract Zod schemas and validation rules from code content."""
    zod_schemas: Dict[str, Dict[str, Any]] = {}

    zod_pattern = re.compile(
        r"""(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*z\.object\s*\(\s*\{([^}]+)\}\s*\)""",
        re.MULTILINE,
    )
    for match in zod_pattern.finditer(content):
        schema_name = match.group(1)
        body = match.group(2)
        fields: List[Dict[str, Any]] = []

        field_line_pattern = re.compile(r"""([a-zA-Z0-9_]+)\s*:\s*z\.([a-zA-Z0-9_]+)\(([^)]*)\)([^,\n]*)""")
        for fmatch in field_line_pattern.finditer(body):
            f_name = fmatch.group(1)
            f_base_type = fmatch.group(2)
            f_rest = fmatch.group(4)
            is_optional = ".optional()" in f_rest or ".nullable()" in f_rest
            fields.append({
                "name": f_name,
                "zod_type": f_base_type,
                "optional": is_optional,
                "raw_validator": f"z.{f_base_type}({fmatch.group(3)}){f_rest.strip()}",
            })

        if fields:
            zod_schemas[schema_name] = {
                "schema_name": schema_name,
                "fields": fields,
            }

    return zod_schemas


def parse_firestore_rules(rules_path: Path) -> Dict[str, Any]:
    """Parse firestore.rules file to extract match blocks, subcollections, and security conditions."""
    if not rules_path.is_file():
        return {"present": False, "rules": []}

    content = read_text_safe(rules_path)
    match_blocks: List[Dict[str, Any]] = []

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

    role_check_regex = re.compile(r"""(?:token\.role|role)\s*==\s*['"]([a-zA-Z0-9_\-]+)['"]""")
    stack: List[Dict[str, Any]] = []

    for match in token_pattern.finditer(cleaned):
        allow_stmt = match.group(1)
        match_block_start = match.group(2)
        open_brace = match.group(3)
        close_brace = match.group(4)

        if allow_stmt:
            a_match = re.search(r"""allow\s+([^:]+):\s*if\s+([^;]+);""", allow_stmt)
            if a_match:
                ops = [op.strip() for op in a_match.group(1).split(",")]
                cond = a_match.group(2).strip()
                roles: Set[str] = set()
                for rmatch in role_check_regex.finditer(cond):
                    roles.add(rmatch.group(1))
                allow_entry = {
                    "operations": ops,
                    "condition": cond,
                    "requires_auth": "request.auth" in cond,
                    "roles_enforced": sorted(list(roles)),
                }
                for frame in reversed(stack):
                    if frame.get("is_match"):
                        frame["allows"].append(allow_entry)
                        frame["roles"].update(roles)
                        break

        elif match_block_start:
            m = re.match(r"""match\s+([^\s{]+(?:\{[^{}]+\}[^\s{]*)*)\s*\{""", match_block_start)
            raw_p = m.group(1).strip() if m else ""
            raw_p = re.sub(r"""^/databases/\{[^{}]+\}/documents/?""", "", raw_p)
            if not raw_p or ("/databases/" in raw_p and "/documents" in raw_p):
                stack.append({
                    "is_match": False,
                    "path": "",
                    "allows": [],
                    "roles": set(),
                })
            else:
                stack.append({
                    "is_match": True,
                    "path": raw_p.strip("/"),
                    "allows": [],
                    "roles": set(),
                })

        elif open_brace:
            stack.append({
                "is_match": False,
                "path": "",
                "allows": [],
                "roles": set(),
            })

        elif close_brace:
            if stack:
                top = stack.pop()
                if top.get("is_match") and top["allows"]:
                    active_parts = [f["path"] for f in stack if f.get("is_match") and f["path"]] + [top["path"]]
                    full_rule_path = "/" + "/".join([p for p in active_parts if p])
                    match_blocks.append({
                        "path": full_rule_path,
                        "allows": top["allows"],
                        "roles_allowed": sorted(list(top["roles"])),
                    })

    # Sort match blocks by path length so parent scopes precede nested scopes
    match_blocks.sort(key=lambda b: len(b["path"]))

    return {
        "present": True,
        "rules_file": str(rules_path).replace("\\", "/"),
        "rules": match_blocks,
    }



def parse_collection_args(raw_args: str) -> List[str]:
    """Parse comma-separated arguments from collection call into normalized segments."""
    items: List[str] = []
    # Split by comma outside quotes
    tokens = re.findall(r"""['"]([^'"]+)['"]|([a-zA-Z0-9_.]+)""", raw_args)
    for lit, ident in tokens:
        if lit:
            items.append(lit)
        elif ident and ident not in ("db", "firestore", "null", "undefined"):
            items.append(f"{{{ident}}}")
    return items


def match_interface_to_collection(col_name: str, interfaces: Dict[str, List[Dict[str, Any]]]) -> Optional[str]:
    """Match collection name to interface using naming heuristics."""
    clean_col = col_name.strip("/").split("/")[-1].lower()
    singular = clean_col.rstrip("s") if clean_col.endswith("s") else clean_col

    for iface_name in interfaces:
        lower_iface = iface_name.lower()
        if lower_iface == clean_col or lower_iface == singular:
            return iface_name
        if singular in lower_iface:
            return iface_name
    return None


def match_zod_schema_to_collection(col_name: str, zod_schemas: Dict[str, Dict[str, Any]]) -> Optional[str]:
    """Match collection name to Zod schema using naming heuristics."""
    clean_col = col_name.strip("/").split("/")[-1].lower()
    singular = clean_col.rstrip("s") if clean_col.endswith("s") else clean_col

    for schema_name in zod_schemas:
        lower_schema = schema_name.lower()
        if clean_col in lower_schema or singular in lower_schema:
            return schema_name
    return None


def extract_firestore_schemas(repo_path: Path) -> Dict[str, Any]:
    """Scan repo for Firestore collection references, schemas, and security rules."""
    resolved_repo = repo_path.resolve()
    if not resolved_repo.exists() or not resolved_repo.is_dir():
        raise ValueError(f"Target repository directory does not exist: {resolved_repo}")

    collections: Dict[str, Dict[str, Any]] = {}
    subcollections: Dict[str, Dict[str, Any]] = {}
    all_interfaces: Dict[str, List[Dict[str, Any]]] = {}
    all_zod_schemas: Dict[str, Dict[str, Any]] = {}
    mutation_hooks_list: List[Dict[str, Any]] = []

    for entry in resolved_repo.rglob("*"):
        if not entry.is_file():
            continue
        if "node_modules" in entry.parts or ".next" in entry.parts or ".git" in entry.parts:
            continue
        if entry.suffix not in CODE_EXTENSIONS:
            continue

        content = read_text_safe(entry)
        rel_path = str(entry.relative_to(resolved_repo)).replace("\\", "/")

        # Extract TypeScript interfaces
        if entry.suffix in {".ts", ".tsx"}:
            file_interfaces = extract_typescript_interfaces(content)
            all_interfaces.update(file_interfaces)

            file_zod_schemas = extract_zod_schemas(content)
            all_zod_schemas.update(file_zod_schemas)

        # Detect mutation hooks (useMutation, useQuery, useSWR)
        for m_hook in MUTATION_HOOK_REGEX.finditer(content):
            hook_name = m_hook.group(1)
            line_num = content[:m_hook.start()].count("\n") + 1
            mutation_hooks_list.append({
                "hook": hook_name,
                "file": rel_path,
                "line": line_num,
            })

        # Process modular collection calls
        for match in MODULAR_COLLECTION_REGEX.finditer(content):
            doc_args = match.group(1)
            if doc_args is not None:
                doc_segs = parse_collection_args(doc_args.strip())
                col_segs = parse_collection_args(match.group(2).strip()) if match.group(2) else []
                segments = doc_segs + col_segs
            else:
                raw_args = match.group(3).strip() if match.group(3) else ""
                segments = parse_collection_args(raw_args)

            if not segments:
                # Fallback to simple literal match
                lit_match = re.search(r"""['"]([a-zA-Z0-9_\-/]+)['"]""", match.group(0))
                if lit_match:
                    segments = [lit_match.group(1)]
                else:
                    continue

            # Determine top collection and full path
            first_seg = segments[0]
            if "/" in first_seg:
                raw_parts = [p for p in first_seg.split("/") if p] + segments[1:]
                col_name = raw_parts[0]
                full_path = "/".join(raw_parts)
                is_sub = len(raw_parts) > 1
            else:
                col_name = first_seg
                full_path = "/".join(segments)
                is_sub = len(segments) > 2 or (len(segments) > 1 and "{" in segments[1])

            # Register top-level collection
            if col_name not in collections:
                collections[col_name] = {
                    "collection_name": col_name,
                    "raw_paths": set(),
                    "occurrences": [],
                    "query_fields": set(),
                    "order_by_fields": set(),
                    "data_fields": set(),
                    "subcollections": set(),
                    "operations": {"read": 0, "write": 0, "listen": 0, "delete": 0, "total": 0},
                }

            collections[col_name]["raw_paths"].add(full_path)

            line_num = content[:match.start()].count("\n") + 1
            surrounding = content[max(0, match.start() - 200):min(len(content), match.end() + 200)]

            op_detected = "reference"
            if "onSnapshot" in surrounding:
                op_detected = "listen"
                collections[col_name]["operations"]["listen"] += 1
            elif any(op in surrounding for op in READ_OPERATIONS):
                op_detected = "read"
                collections[col_name]["operations"]["read"] += 1
            elif "deleteDoc" in surrounding or ".delete(" in surrounding:
                op_detected = "delete"
                collections[col_name]["operations"]["delete"] += 1
            elif any(op in surrounding for op in WRITE_OPERATIONS):
                op_detected = "write"
                collections[col_name]["operations"]["write"] += 1

            collections[col_name]["operations"]["total"] += 1
            collections[col_name]["occurrences"].append({
                "file": rel_path,
                "line": line_num,
                "operation": op_detected,
            })

            # Record subcollection if nested
            if is_sub and full_path != col_name:
                collections[col_name]["subcollections"].add(full_path)
                if full_path not in subcollections:
                    subcollections[full_path] = {
                        "path": full_path,
                        "parent_collection": col_name,
                        "occurrences": [],
                    }
                subcollections[full_path]["occurrences"].append({
                    "file": rel_path,
                    "line": line_num,
                    "operation": op_detected,
                })

        # Compat collection calls
        for match in COMPAT_COLLECTION_REGEX.finditer(content):
            raw_name = match.group(1).strip()
            parts = [p for p in raw_name.split("/") if p]
            if not parts:
                continue
            col_name = parts[0]
            is_sub = len(parts) > 1

            if col_name not in collections:
                collections[col_name] = {
                    "collection_name": col_name,
                    "raw_paths": set(),
                    "occurrences": [],
                    "query_fields": set(),
                    "order_by_fields": set(),
                    "data_fields": set(),
                    "subcollections": set(),
                    "operations": {"read": 0, "write": 0, "listen": 0, "delete": 0, "total": 0},
                }

            collections[col_name]["raw_paths"].add(raw_name)
            if is_sub:
                collections[col_name]["subcollections"].add(raw_name)
                if raw_name not in subcollections:
                    subcollections[raw_name] = {
                        "path": raw_name,
                        "parent_collection": col_name,
                        "occurrences": [],
                    }

            line_num = content[:match.start()].count("\n") + 1
            collections[col_name]["occurrences"].append({
                "file": rel_path,
                "line": line_num,
                "operation": "reference",
            })
            collections[col_name]["operations"]["total"] += 1

        # Query filters
        for match in WHERE_REGEX.finditer(content):
            field = match.group(1)
            for col in collections.values():
                col["query_fields"].add(field)

        for match in ORDER_BY_REGEX.finditer(content):
            field = match.group(1)
            for col in collections.values():
                col["order_by_fields"].add(field)

        for match in DATA_FIELD_REGEX.finditer(content):
            field = match.group(1)
            for col in collections.values():
                col["data_fields"].add(field)

    rules_file = resolved_repo / "firestore.rules"
    rules_data = parse_firestore_rules(rules_file)

    for rule in rules_data.get("rules", []):
        rule_path = rule["path"].strip("/")
        parts = [p for p in rule_path.split("/") if p]
        candidate_col = parts[0] if parts else ""
        if candidate_col and candidate_col not in collections:
            collections[candidate_col] = {
                "collection_name": candidate_col,
                "raw_paths": {candidate_col},
                "occurrences": [],
                "query_fields": set(),
                "order_by_fields": set(),
                "data_fields": set(),
                "subcollections": set(),
                "operations": {"read": 0, "write": 0, "listen": 0, "delete": 0, "total": 0},
            }
        if len(parts) > 2:
            subcol_path = "/".join(parts[:3])
            if candidate_col in collections:
                collections[candidate_col]["subcollections"].add(subcol_path)
            if subcol_path not in subcollections:
                subcollections[subcol_path] = {
                    "path": subcol_path,
                    "parent_collection": candidate_col,
                    "occurrences": [],
                }

    collections_out: Dict[str, Any] = {}
    for col_name, cdata in collections.items():
        matched_iface = match_interface_to_collection(col_name, all_interfaces)
        declared_fields = all_interfaces.get(matched_iface, []) if matched_iface else []

        matched_zod = match_zod_schema_to_collection(col_name, all_zod_schemas)

        combined_fields: List[Dict[str, Any]] = list(declared_fields)
        existing_names = {f["name"] for f in combined_fields}

        for qf in sorted(cdata["query_fields"]):
            if qf not in existing_names:
                combined_fields.append({"name": qf, "type": "unknown", "optional": True, "source": "query_filter"})
                existing_names.add(qf)

        for df in sorted(cdata["data_fields"]):
            if df not in existing_names:
                combined_fields.append({"name": df, "type": "unknown", "optional": True, "source": "code_usage"})
                existing_names.add(df)

        matching_rule = None
        for r in rules_data.get("rules", []):
            if col_name in r["path"]:
                matching_rule = r
                break

        collections_out[col_name] = {
            "collection_name": col_name,
            "matched_type": matched_iface,
            "matched_zod_schema": matched_zod,
            "fields": combined_fields,
            "query_filters": sorted(list(cdata["query_fields"])),
            "order_by_fields": sorted(list(cdata["order_by_fields"])),
            "subcollections": sorted(list(cdata["subcollections"])),
            "operations": cdata["operations"],
            "security_rule": matching_rule,
            "occurrences": cdata["occurrences"],
        }

    subcollections_out: Dict[str, Any] = {
        k: {
            "path": v["path"],
            "parent_collection": v["parent_collection"],
            "matched_type": match_interface_to_collection(v["path"], all_interfaces),
            "occurrences_count": len(v["occurrences"]),
        }
        for k, v in subcollections.items()
    }

    summary = {
        "total_collections": len(collections_out),
        "total_subcollections": len(subcollections_out),
        "total_interfaces_detected": len(all_interfaces),
        "total_zod_schemas_detected": len(all_zod_schemas),
        "total_mutation_hooks_detected": len(mutation_hooks_list),
        "firestore_rules_found": rules_data.get("present", False),
        "total_collection_operations": sum(c["operations"]["total"] for c in collections_out.values()),
    }

    return {
        "scanner": "extract_firestore_schemas.py",
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "repo_path": str(resolved_repo).replace("\\", "/"),
        "summary": summary,
        "security_posture": rules_data,
        "collections": collections_out,
        "subcollections": subcollections_out,
        "discovered_interfaces": all_interfaces,
        "zod_schemas": all_zod_schemas,
        "mutation_hooks": mutation_hooks_list,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract Firestore collections, schemas, and security rules.")
    parser.add_argument("--repo-path", required=True, type=Path, help="Path to target Next.js/Firebase repository.")
    parser.add_argument("--output", type=Path, default=Path("firestore_schema_inventory.json"), help="Output JSON path.")
    args = parser.parse_args()

    inventory = extract_firestore_schemas(args.repo_path)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(inventory, f, indent=2)

    print(f"Extracted {inventory['summary']['total_collections']} collections. Output saved to {args.output}")


if __name__ == "__main__":
    main()
