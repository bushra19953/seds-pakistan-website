"""SEDS Website Audit Runner.

Master orchestrator executing the full codebase audit pipeline across Next.js
routes, component AST hierarchies, database schemas, RBAC auth guards,
and BRAG inventory generation.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def parse_args() -> argparse.Namespace:
    """Parse command line options for audit runner."""
    parser = argparse.ArgumentParser(
        description="Master single-command audit runner for SEDS Pakistan website codebase."
    )
    parser.add_argument(
        "--repo-path",
        required=True,
        type=Path,
        help="Path to target Next.js repository root.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("./audit_output"),
        help="Path to output deliverables directory.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable detailed telemetry output during execution.",
    )
    return parser.parse_args()


def run_subcommand(cmd: List[str], description: str, verbose: bool = False) -> subprocess.CompletedProcess:
    """Execute Python subprocess command and handle failures."""
    if verbose:
        print(f"[EXEC] {' '.join(cmd)}")

    start_time = time.time()
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    elapsed = time.time() - start_time

    if proc.returncode != 0:
        print(f"[FAIL] {description} exited with code {proc.returncode} in {elapsed:.2f}s")
        if proc.stdout:
            print("--- STDOUT ---")
            print(proc.stdout)
        if proc.stderr:
            print("--- STDERR ---")
            print(proc.stderr)
        raise RuntimeError(f"Step failed: {description}")

    if verbose and proc.stdout:
        for line in proc.stdout.strip().split("\n"):
            print(f"  {line}")

    return proc


def copy_alias_file(source_file: Path, alias_file: Path) -> None:
    """Duplicate inventory file to satisfy alternative schema naming contracts."""
    if source_file.is_file():
        shutil.copy2(source_file, alias_file)


def execute_audit_pipeline(
    repo_path: Path,
    output_dir: Path,
    verbose: bool = False,
) -> Dict[str, Any]:
    """Orchestrate all audit passes in sequential order."""
    resolved_repo = repo_path.resolve()
    if not resolved_repo.exists():
        print(f"Error: Target repository does not exist: {resolved_repo}")
        sys.exit(1)

    resolved_out = output_dir.resolve()
    resolved_out.mkdir(parents=True, exist_ok=True)
    checkpoints_dir = resolved_out / "lobe_checkpoints"
    checkpoints_dir.mkdir(parents=True, exist_ok=True)

    scripts_dir = Path(__file__).parent.resolve()
    python_bin = sys.executable

    print("==================================================================")
    print("      SEDS PAKISTAN CODEBASE AUDIT PIPELINE INITIALIZED           ")
    print("==================================================================")
    print(f"Target Repository:  {resolved_repo}")
    print(f"Output Directory:   {resolved_out}")
    print(f"Timestamp (UTC):    {datetime.now(timezone.utc).isoformat()}")
    print("==================================================================\n")

    pipeline_start = time.time()
    steps_executed: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Pass 1: Component AST and Dependency Graph Analysis
    # ------------------------------------------------------------------
    print("[PASS 1/7] Analyzing Component AST, JSX Trees, Forms, and Dependencies...")
    ast_script = scripts_dir / "analyze_components_ast.py"
    tree_out = resolved_out / "component_tree.json"
    graph_out = resolved_out / "dependency_graph.json"

    ast_cmd = [
        python_bin,
        str(ast_script),
        "--repo-path",
        str(resolved_repo),
        "--output-tree",
        str(tree_out),
        "--output-graph",
        str(graph_out),
    ]
    if verbose:
        ast_cmd.append("--verbose")

    run_subcommand(ast_cmd, "Component AST analysis", verbose=verbose)

    # Read summary from generated component tree
    with open(tree_out, "r", encoding="utf-8") as f:
        ast_data = json.load(f)
    ast_sum = ast_data.get("summary", {})
    print(f"       Cataloged: {ast_sum.get('total_files_cataloged', 0)} files")
    print(f"       Routes in tree: {ast_sum.get('total_routes_analyzed', 0)}")
    print(f"       CAD Dropzones: {ast_sum.get('routes_with_cad_dropzones', 0)}")
    print(f"       Dead components: {ast_sum.get('unreferenced_dead_components_count', 0)}")
    steps_executed.append({"pass": 1, "name": "analyze_components_ast", "status": "COMPLETED"})

    # ------------------------------------------------------------------
    # Pass 2: Next.js Route Scanning
    # ------------------------------------------------------------------
    print("\n[PASS 2/7] Scanning Next.js App Router and Pages Router Routes...")
    routes_script = scripts_dir / "scan_nextjs_routes.py"
    routes_out = resolved_out / "nextjs_routes_inventory.json"
    manifest_out = resolved_out / "routes_manifest.json"

    routes_cmd = [
        python_bin,
        str(routes_script),
        "--repo-path",
        str(resolved_repo),
        "--output",
        str(routes_out),
    ]
    run_subcommand(routes_cmd, "Next.js route scan", verbose=verbose)
    copy_alias_file(routes_out, manifest_out)

    with open(routes_out, "r", encoding="utf-8") as f:
        routes_data = json.load(f)
    routes_sum = routes_data.get("summary", {})
    print(f"       Total routes: {routes_sum.get('total_routes', 0)}")
    print(f"       Page routes: {routes_sum.get('page_routes', 0)}")
    print(f"       API routes: {routes_sum.get('api_routes', 0)}")
    print(f"       Protected routes: {routes_sum.get('protected_routes', 0)}")
    steps_executed.append({"pass": 2, "name": "scan_nextjs_routes", "status": "COMPLETED"})

    # ------------------------------------------------------------------
    # Pass 3: Firestore Schema Extraction
    # ------------------------------------------------------------------
    print("\n[PASS 3/7] Extracting Firestore Collections and Schemas...")
    firestore_script = scripts_dir / "extract_firestore_schemas.py"
    firestore_out = resolved_out / "firestore_schema_inventory.json"
    schemas_out = resolved_out / "firestore_schemas.json"

    firestore_cmd = [
        python_bin,
        str(firestore_script),
        "--repo-path",
        str(resolved_repo),
        "--output",
        str(firestore_out),
    ]
    run_subcommand(firestore_cmd, "Firestore schema extraction", verbose=verbose)
    copy_alias_file(firestore_out, schemas_out)

    with open(firestore_out, "r", encoding="utf-8") as f:
        firestore_data = json.load(f)
    fs_sum = firestore_data.get("summary", {})
    print(f"       Collections: {fs_sum.get('total_collections', 0)}")
    print(f"       Interfaces: {fs_sum.get('total_interfaces_detected', 0)}")
    print(f"       Security rules: {'FOUND' if fs_sum.get('firestore_rules_found') else 'NONE'}")
    steps_executed.append({"pass": 3, "name": "extract_firestore_schemas", "status": "COMPLETED"})

    # ------------------------------------------------------------------
    # Pass 4: RBAC and Authentication Audit
    # ------------------------------------------------------------------
    print("\n[PASS 4/7] Auditing RBAC Access Control and Auth Signals...")
    rbac_script = scripts_dir / "audit_rbac_auth.py"
    rbac_out = resolved_out / "rbac_auth_inventory.json"
    audit_out = resolved_out / "rbac_audit.json"

    rbac_cmd = [
        python_bin,
        str(rbac_script),
        "--repo-path",
        str(resolved_repo),
        "--output",
        str(rbac_out),
    ]
    run_subcommand(rbac_cmd, "RBAC auth audit", verbose=verbose)
    copy_alias_file(rbac_out, audit_out)

    with open(rbac_out, "r", encoding="utf-8") as f:
        rbac_data = json.load(f)
    rbac_sum = rbac_data.get("summary", {})
    roles_list = rbac_sum.get("roles_discovered", [])
    print(f"       Roles discovered: {len(roles_list)} ({', '.join(roles_list) if roles_list else 'none'})")
    print(f"       Auth methods: {rbac_sum.get('active_auth_methods_count', 0)}")
    print(f"       Security findings: {rbac_sum.get('security_findings_count', 0)}")
    steps_executed.append({"pass": 4, "name": "audit_rbac_auth", "status": "COMPLETED"})

    # ------------------------------------------------------------------
    # Pass 5: Hardware Storage Audit (Conditional)
    # ------------------------------------------------------------------
    hardware_script = scripts_dir / "audit_hardware_storage.py"
    storage_out = resolved_out / "storage_schemas.json"
    hardware_out = resolved_out / "hardware_pipeline_inventory.json"
    if hardware_script.is_file():
        print("\n[PASS 5/7] Auditing CAD Storage and Binary Intake Pipeline...")
        hw_cmd = [
            python_bin,
            str(hardware_script),
            "--repo-path",
            str(resolved_repo),
            "--output",
            str(storage_out),
        ]
        run_subcommand(hw_cmd, "Hardware storage audit", verbose=verbose)
        copy_alias_file(storage_out, hardware_out)
        print("       Hardware storage audit complete.")
        steps_executed.append({"pass": 5, "name": "audit_hardware_storage", "status": "COMPLETED"})
    else:
        print("\n[PASS 5/7] Hardware storage scanner not present on disk (Milestone 2 feature). Skipping.")
        steps_executed.append({"pass": 5, "name": "audit_hardware_storage", "status": "SKIPPED_NOT_PRESENT"})

    # ------------------------------------------------------------------
    # Pass 6: External Services Audit (Conditional)
    # ------------------------------------------------------------------
    external_script = scripts_dir / "audit_external_services.py"
    ext_out = resolved_out / "external_services.json"
    ext_inv_out = resolved_out / "external_services_inventory.json"
    if external_script.is_file():
        print("\n[PASS 6/7] Auditing External Services, Webhooks, and Hosting Configurations...")
        ext_cmd = [
            python_bin,
            str(external_script),
            "--repo-path",
            str(resolved_repo),
            "--output",
            str(ext_out),
        ]
        run_subcommand(ext_cmd, "External services audit", verbose=verbose)
        copy_alias_file(ext_out, ext_inv_out)
        print("       External services audit complete.")
        steps_executed.append({"pass": 6, "name": "audit_external_services", "status": "COMPLETED"})
    else:
        print("\n[PASS 6/7] External services scanner not present on disk (Milestone 2 feature). Skipping.")
        steps_executed.append({"pass": 6, "name": "audit_external_services", "status": "SKIPPED_NOT_PRESENT"})

    # ------------------------------------------------------------------
    # Pass 7: BRAG Capability Matrix and Ground Truth Deliverables
    # ------------------------------------------------------------------
    print("\n[PASS 7/7] Synthesizing BRAG Capabilities, Schema, and Brain Bundle...")
    brag_script = scripts_dir / "generate_brag_report.py"

    brag_cmd = [
        python_bin,
        str(brag_script),
        "--routes",
        str(routes_out),
        "--firestore",
        str(firestore_out),
        "--rbac",
        str(rbac_out),
        "--output-dir",
        str(resolved_out),
    ]
    run_subcommand(brag_cmd, "BRAG report generation", verbose=verbose)

    brag_report_file = resolved_out / "CAPABILITIES_BRAG_REPORT.md"
    ground_truth_file = resolved_out / "GROUND_TRUTH_SCHEMA.json"
    brain_bundle_file = resolved_out / "SEDS_BRAIN_INGESTION_BUNDLE.md"

    print(f"       BRAG Report:       {brag_report_file.name} ({brag_report_file.stat().st_size} bytes)")
    print(f"       Master Schema:     {ground_truth_file.name} ({ground_truth_file.stat().st_size} bytes)")
    print(f"       Brain Bundle:      {brain_bundle_file.name} ({brain_bundle_file.stat().st_size} bytes)")
    steps_executed.append({"pass": 7, "name": "generate_brag_report", "status": "COMPLETED"})

    total_duration = time.time() - pipeline_start

    # Assemble master summary manifest
    execution_summary = {
        "pipeline": "audit_runner.py",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": round(total_duration, 2),
        "target_repo": str(resolved_repo),
        "output_directory": str(resolved_out),
        "steps_executed": steps_executed,
        "deliverables": {
            "component_tree": str(tree_out),
            "dependency_graph": str(graph_out),
            "routes_inventory": str(routes_out),
            "firestore_inventory": str(firestore_out),
            "rbac_inventory": str(rbac_out),
            "brag_report": str(brag_report_file),
            "ground_truth_schema": str(ground_truth_file),
            "brain_bundle": str(brain_bundle_file),
        },
    }

    summary_path = resolved_out / "audit_execution_summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(execution_summary, f, indent=2)

    print("\n==================================================================")
    print("           AUDIT PIPELINE COMPLETED WITH SUCCESS                  ")
    print("==================================================================")
    print(f"Total Duration:     {total_duration:.2f} seconds")
    print(f"Execution Summary:  {summary_path}")
    print(f"Deliverables Root:  {resolved_out}")
    print("==================================================================\n")

    return execution_summary


def main() -> None:
    args = parse_args()
    try:
        execute_audit_pipeline(
            repo_path=args.repo_path,
            output_dir=args.output_dir,
            verbose=args.verbose,
        )
        sys.exit(0)
    except Exception as exc:
        print(f"\n[FATAL ERROR] Audit pipeline aborted: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
