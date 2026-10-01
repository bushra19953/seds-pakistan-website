#!/usr/bin/env python3
"""
SEDS Audit Deliverable Verification Tool
Validates presence, non-zero file sizes, and internal structures
of audit output deliverables.
"""

import sys
import json
import argparse
from pathlib import Path

def parse_args():
    parser = argparse.ArgumentParser(description="SEDS Audit Deliverables Verifier")
    parser.add_argument("--output-dir", default="./audit_output", help="Path to audit output directory")
    return parser.parse_args()

def verify_file_exists(file_path: Path, min_bytes: int = 100):
    if not file_path.exists():
        print(f"FAIL: Missing expected deliverable: {file_path.name}")
        return False
    size = file_path.stat().st_size
    if size < min_bytes:
        print(f"FAIL: File {file_path.name} is undersized ({size} bytes < {min_bytes} threshold)")
        return False
    print(f"PASS: {file_path.name} exists ({size} bytes)")
    return True

def verify_json_schema(file_path: Path):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        required_keys = ["collections", "endpoints", "roles"]
        missing = [k for k in required_keys if k not in data]
        if missing:
            print(f"FAIL: {file_path.name} missing required top-level keys: {missing}")
            return False
        print(f"PASS: {file_path.name} is valid JSON with required architecture keys")
        return True
    except Exception as err:
        print(f"FAIL: {file_path.name} failed JSON parsing: {err}")
        return False

def verify_markdown_content(file_path: Path, required_tokens: list):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        missing = [tok for tok in required_tokens if tok not in content]
        if missing:
            print(f"FAIL: {file_path.name} missing required sections or tokens: {missing}")
            return False
        print(f"PASS: {file_path.name} contains all required structural sections")
        return True
    except Exception as err:
        print(f"FAIL: {file_path.name} read error: {err}")
        return False

def main():
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()

    if not output_dir.exists():
        print(f"FAIL: Output directory does not exist: {output_dir}")
        sys.exit(1)

    all_passed = True

    # 1. Verify CAPABILITIES_BRAG_REPORT.md
    brag_file = output_dir / "CAPABILITIES_BRAG_REPORT.md"
    if verify_file_exists(brag_file, 500):
        tokens = ["Tier 1", "Tier 2", "Tier 3", "Data Persistence", "Access Control"]
        if not verify_markdown_content(brag_file, tokens):
            all_passed = False
    else:
        all_passed = False

    # 2. Verify GROUND_TRUTH_SCHEMA.json
    schema_file = output_dir / "GROUND_TRUTH_SCHEMA.json"
    if verify_file_exists(schema_file, 100):
        if not verify_json_schema(schema_file):
            all_passed = False
    else:
        all_passed = False

    # 3. Verify SEDS_BRAIN_INGESTION_BUNDLE.md
    ingest_file = output_dir / "SEDS_BRAIN_INGESTION_BUNDLE.md"
    if verify_file_exists(ingest_file, 500):
        tokens = ["node_id", "SEDS-WEB-PORTAL-L1", "SEDS-INTAKE-CAD-L1", "flowchart", "subgraph"]
        if not verify_markdown_content(ingest_file, tokens):
            all_passed = False
    else:
        all_passed = False

    if all_passed:
        print("\nSUCCESS: All SEDS audit deliverables verified. Ready for transmission to Zubair.")
        sys.exit(0)
    else:
        print("\nFAILURE: One or more audit deliverable checks failed.")
        sys.exit(1)

if __name__ == "__main__":
    main()

