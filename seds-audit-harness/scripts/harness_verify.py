"""SEDS Audit Harness Acceptance Verification Suite.

This script executes acceptance checks across all harness scanners and
generators. It verifies syntax, builds a test fixture repository, runs
end-to-end scanner pipelines, validates JSON schemas, and confirms compliance
with stop-slop prose rules.
"""

from __future__ import annotations

import argparse
import ast
import json
import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Set

SCRIPTS = [
    "scan_nextjs_routes.py",
    "extract_firestore_schemas.py",
    "audit_rbac_auth.py",
    "generate_brag_report.py",
    "harness_verify.py",
]

ALLOWED_EXCEPTIONS = {
    "apply",
    "early",
    "rely",
    "only",
    "daily",
    "assembly",
    "family",
    "supply",
    "multiply",
    "reply",
}

EM_DASH_PATTERNS = [
    re.compile(r"""\u2014"""),
    re.compile(r"""\u2013"""),
    re.compile(r"""\s--\s"""),
]


def check_script_syntax(scripts_dir: Path) -> List[str]:
    """Compile all scripts to ensure zero syntax errors."""
    errors: List[str] = []
    for script_name in SCRIPTS:
        script_path = scripts_dir / script_name
        if not script_path.is_file():
            errors.append(f"Missing required script: {script_name}")
            continue
        try:
            py_compile.compile(str(script_path), doraise=True)
        except py_compile.PyCompileError as e:
            errors.append(f"Syntax error in {script_name}: {e}")
    return errors


def extract_python_prose(file_path: Path) -> str:
    """Extract docstrings, comments, and string templates from Python code."""
    source = file_path.read_text(encoding="utf-8")
    prose_fragments: List[str] = []

    for line in source.split("\n"):
        comment_idx = line.find("#")
        if comment_idx != -1:
            comment_text = line[comment_idx + 1 :].strip()
            prose_fragments.append(comment_text)

    try:
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.Module)):
                doc = ast.get_docstring(node)
                if doc:
                    prose_fragments.append(doc)
    except Exception:
        pass

    return "\n".join(prose_fragments)


def check_stop_slop_compliance(text: str, filename: str) -> List[str]:
    """Check prose text for em dashes and adverbs ending in -ly."""
    issues: List[str] = []

    for pattern in EM_DASH_PATTERNS:
        if pattern.search(text):
            issues.append(f"Found em dash in {filename}")
            break

    words = re.findall(r"""\b[a-zA-Z]+\b""", text)
    for word in words:
        lower = word.lower()
        if lower.endswith("ly") and len(lower) > 3 and lower not in ALLOWED_EXCEPTIONS:
            issues.append(f"Found adverb ending in -ly ('{word}') in {filename}")
            break

    return issues


def create_mock_seds_repository(target_dir: Path) -> None:
    """Create a mock Next.js and Firebase repository fixture for testing."""
    app_dir = target_dir / "app"
    pages_dir = target_dir / "pages"
    types_dir = target_dir / "types"
    actions_dir = app_dir / "actions"

    app_dir.mkdir(parents=True, exist_ok=True)
    pages_dir.mkdir(parents=True, exist_ok=True)
    types_dir.mkdir(parents=True, exist_ok=True)
    actions_dir.mkdir(parents=True, exist_ok=True)

    (app_dir / "layout.tsx").write_text(
        """import React from 'react';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
""",
        encoding="utf-8",
    )

    (app_dir / "page.tsx").write_text(
        """import React from 'react';
export default function HomePage() {
  return <main><h1>SEDS Platform</h1></main>;
}
""",
        encoding="utf-8",
    )

    auth_dir = app_dir / "(auth)" / "login"
    auth_dir.mkdir(parents=True, exist_ok=True)
    (auth_dir / "page.tsx").write_text(
        """"use client";
import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const handleLogin = async () => {
    await signInWithEmailAndPassword(null as any, email, password);
  };
  return <form onSubmit={handleLogin}><input value={email} /></form>;
}
""",
        encoding="utf-8",
    )

    dash_chapters = app_dir / "(dashboard)" / "chapters"
    dash_chapters.mkdir(parents=True, exist_ok=True)
    (dash_chapters / "page.tsx").write_text(
        """"use client";
import React, { useEffect, useState } from 'react';
import { collection, onSnapshot, getDocs, query, where } from 'firebase/firestore';

export default function ChaptersPage() {
  const [role, setRole] = useState('chapter_lead');
  useEffect(() => {
    const q = query(collection(null as any, "chapters"), where("status", "==", "active"));
    onSnapshot(q, (snapshot) => {
      console.log(snapshot.docs);
    });
  }, []);

  if (role === 'chapter_lead') {
    return <div>Chapter Lead Panel</div>;
  }
  return <div>Public Chapters</div>;
}
""",
        encoding="utf-8",
    )

    chapter_detail = dash_chapters / "[id]"
    chapter_detail.mkdir(parents=True, exist_ok=True)
    (chapter_detail / "page.tsx").write_text(
        """import React from 'react';
import { doc, getDoc, updateDoc } from 'firebase/firestore';

export default async function ChapterDetailPage({ params }: { params: { id: string } }) {
  const chapterRef = doc(null as any, "chapters", params.id);
  const snap = await getDoc(chapterRef);
  return <div>Chapter: {params.id}</div>;
}
""",
        encoding="utf-8",
    )

    api_chapters = app_dir / "api" / "chapters"
    api_chapters.mkdir(parents=True, exist_ok=True)
    (api_chapters / "route.ts").write_text(
        """import { collection, getDocs, addDoc } from 'firebase/firestore';

export async function GET() {
  const snaps = await getDocs(collection(null as any, "chapters"));
  return Response.json({ count: snaps.size });
}

export async function POST(req: Request) {
  const body = await req.json();
  const ref = await addDoc(collection(null as any, "chapters"), body);
  return Response.json({ id: ref.id });
}
""",
        encoding="utf-8",
    )

    api_admin = app_dir / "api" / "admin" / "users"
    api_admin.mkdir(parents=True, exist_ok=True)
    (api_admin / "route.ts").write_text(
        """import { getAuth } from 'firebase-admin/auth';

export async function POST(req: Request) {
  const auth = getAuth();
  const { token, targetUid, targetRole } = await req.json();
  const decoded = await auth.verifyIdToken(token);
  if (decoded.role !== 'admin') {
    return new Response("Unauthorized", { status: 403 });
  }
  await auth.setCustomUserClaims(targetUid, { role: targetRole });
  return Response.json({ success: true });
}
""",
        encoding="utf-8",
    )

    (actions_dir / "chapter-actions.ts").write_text(
        """"use server";
import { doc, updateDoc } from 'firebase/firestore';

export async function updateChapterStatus(chapterId: string, status: string) {
  const ref = doc(null as any, "chapters", chapterId);
  await updateDoc(ref, { status });
  return { updated: true };
}
""",
        encoding="utf-8",
    )

    (target_dir / "middleware.ts").write_text(
        """import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const token = request.cookies.get('token');
  if (!token && request.nextUrl.pathname.startsWith('/chapters')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/chapters/:path*', '/api/admin/:path*'],
};
""",
        encoding="utf-8",
    )

    pages_events = pages_dir / "events"
    pages_events.mkdir(parents=True, exist_ok=True)
    (pages_events / "[slug].tsx").write_text(
        """import React from 'react';
import { collection, getDocs, query, where, orderBy } from 'firebase/firestore';

export default function EventPage() {
  const q = query(collection(null as any, "events"), where("status", "==", "open"), orderBy("date"));
  return <div>Event Details</div>;
}
""",
        encoding="utf-8",
    )

    (types_dir / "seds.ts").write_text(
        """export interface Chapter {
  id: string;
  name: string;
  leadId: string;
  memberCount: number;
  status: string;
  region: string;
}

export interface User {
  uid: string;
  email: string;
  role: 'admin' | 'chapter_lead' | 'regional_rep' | 'member';
  displayName?: string;
}

export interface Event {
  id: string;
  title: string;
  date: string;
  status: string;
}
""",
        encoding="utf-8",
    )

    (target_dir / "firestore.rules").write_text(
        """rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /chapters/{chapterId} {
      allow read: if true;
      allow write: if request.auth != null && (request.auth.token.role == 'admin' || request.auth.token.role == 'chapter_lead');
    }
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.token.role == 'admin';
    }
    match /events/{eventId} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
""",
        encoding="utf-8",
    )


def run_command_strict(cmd: List[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    """Execute command with strict error checking."""
    result = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Command failed ({' '.join(cmd)}):\nSTDOUT: {result.stdout}\nSTDERR: {result.stderr}")
    return result


def verify_harness(harness_dir: Path) -> bool:
    """Run full verification across the SEDS audit harness suite."""
    scripts_dir = harness_dir / "scripts"
    print(f"Verifying script syntax in: {scripts_dir}")
    syntax_errors = check_script_syntax(scripts_dir)
    if syntax_errors:
        for err in syntax_errors:
            print(f"[ERROR] {err}")
        return False
    print("[PASS] All Python scripts compile without syntax errors.")

    temp_fixture = Path(tempfile.mkdtemp(prefix="seds_fixture_"))
    try:
        print(f"Generating test fixture at: {temp_fixture}")
        create_mock_seds_repository(temp_fixture)
        print("[PASS] Mock SEDS repository created.")

        output_dir = temp_fixture / "audit_outputs"
        output_dir.mkdir(parents=True, exist_ok=True)

        routes_out = output_dir / "nextjs_routes_inventory.json"
        firestore_out = output_dir / "firestore_schema_inventory.json"
        rbac_out = output_dir / "rbac_auth_inventory.json"

        print("Running scan_nextjs_routes.py...")
        run_command_strict(
            [sys.executable, str(scripts_dir / "scan_nextjs_routes.py"), "--repo-path", str(temp_fixture), "--output", str(routes_out)],
            cwd=temp_fixture,
        )
        if not routes_out.is_file():
            print("[ERROR] nextjs_routes_inventory.json was not created.")
            return False

        with open(routes_out, "r", encoding="utf-8") as f:
            routes_data = json.load(f)
        assert routes_data["summary"]["total_routes"] >= 5, "Expected at least 5 routes"
        assert "app" in routes_data["router_types_detected"], "Expected App router detection"
        assert "pages" in routes_data["router_types_detected"], "Expected Pages router detection"
        print(f"[PASS] scan_nextjs_routes.py validated ({routes_data['summary']['total_routes']} routes detected).")

        print("Running extract_firestore_schemas.py...")
        run_command_strict(
            [sys.executable, str(scripts_dir / "extract_firestore_schemas.py"), "--repo-path", str(temp_fixture), "--output", str(firestore_out)],
            cwd=temp_fixture,
        )
        if not firestore_out.is_file():
            print("[ERROR] firestore_schema_inventory.json was not created.")
            return False

        with open(firestore_out, "r", encoding="utf-8") as f:
            firestore_data = json.load(f)
        assert "chapters" in firestore_data["collections"], "Expected chapters collection"
        assert "events" in firestore_data["collections"], "Expected events collection"
        assert "Chapter" in firestore_data["discovered_interfaces"], "Expected Chapter interface"
        print(f"[PASS] extract_firestore_schemas.py validated ({len(firestore_data['collections'])} collections detected).")

        print("Running audit_rbac_auth.py...")
        run_command_strict(
            [sys.executable, str(scripts_dir / "audit_rbac_auth.py"), "--repo-path", str(temp_fixture), "--output", str(rbac_out)],
            cwd=temp_fixture,
        )
        if not rbac_out.is_file():
            print("[ERROR] rbac_auth_inventory.json was not created.")
            return False

        with open(rbac_out, "r", encoding="utf-8") as f:
            rbac_data = json.load(f)
        assert "chapter_lead" in rbac_data["summary"]["roles_discovered"], "Expected chapter_lead role"
        assert "admin" in rbac_data["summary"]["roles_discovered"], "Expected admin role"
        print(f"[PASS] audit_rbac_auth.py validated ({len(rbac_data['roles'])} roles detected).")

        print("Running generate_brag_report.py...")
        run_command_strict(
            [
                sys.executable,
                str(scripts_dir / "generate_brag_report.py"),
                "--routes",
                str(routes_out),
                "--firestore",
                str(firestore_out),
                "--rbac",
                str(rbac_out),
                "--output-dir",
                str(output_dir),
            ],
            cwd=temp_fixture,
        )

        brag_md = output_dir / "CAPABILITIES_BRAG_REPORT.md"
        ground_json = output_dir / "GROUND_TRUTH_SCHEMA.json"
        bundle_md = output_dir / "SEDS_BRAIN_INGESTION_BUNDLE.md"

        assert brag_md.is_file(), "CAPABILITIES_BRAG_REPORT.md missing"
        assert ground_json.is_file(), "GROUND_TRUTH_SCHEMA.json missing"
        assert bundle_md.is_file(), "SEDS_BRAIN_INGESTION_BUNDLE.md missing"

        with open(ground_json, "r", encoding="utf-8") as f:
            ground_data = json.load(f)
        assert len(ground_data["routes"]) >= 5, "Expected routes in unified ground truth schema"
        print("[PASS] generate_brag_report.py validated.")

        print("Auditing prose artifacts for stop-slop compliance...")
        brag_text = brag_md.read_text(encoding="utf-8")
        bundle_text = bundle_md.read_text(encoding="utf-8")

        stop_slop_issues = []
        stop_slop_issues.extend(check_stop_slop_compliance(brag_text, "CAPABILITIES_BRAG_REPORT.md"))
        stop_slop_issues.extend(check_stop_slop_compliance(bundle_text, "SEDS_BRAIN_INGESTION_BUNDLE.md"))

        for script_name in SCRIPTS:
            prose_text = extract_python_prose(scripts_dir / script_name)
            stop_slop_issues.extend(check_stop_slop_compliance(prose_text, script_name))

        if stop_slop_issues:
            for issue in stop_slop_issues:
                print(f"[ERROR] Stop-Slop rule violation: {issue}")
            return False

        print("[PASS] Stop-slop compliance verified. Zero disallowed adverbs. Zero em dashes.")

    finally:
        shutil.rmtree(temp_fixture, ignore_errors=True)

    print("\nALL HARNESS VERIFICATION GATES PASSED")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Run SEDS Audit Harness verification suite.")
    parser.add_argument("--harness-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()

    success = verify_harness(args.harness_dir)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
