// Regression guard: the induction cutoff moved twice tonight (Oct 15 -> Oct 16).
// This script fails CI loudly if any copy of the cutoff date drifts from the
// single source of truth. No dependencies; run: node scripts/verify-induction-cutoff.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_ISO = "2026-10-16T23:59:59+05:00";
const EXPECTED_COPY = "Friday, Oct 16 at 11:59 PM PKT";
const CLOSED_TITLE = "Applications Closed";
const DEADLINE_FILE = "src/lib/application-deadline.ts";
const COPY_FILES = [
  "src/app/induction/page.tsx",
  "src/components/sections/induction-hero-section.tsx",
];
const STALE_SCAN_DIRS = ["src/app/induction", "src/app/join", "src/app/apply"];
const STALE_MARKER = "Oct 15";

const failures = [];
const passes = [];

function check(name, ok, detail = "") {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? ` -- ${detail}` : ""}`);
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// (1) Single source of truth: the ISO constant.
const deadlineSrc = read(DEADLINE_FILE);
check(
  "deadline constant equals expected ISO",
  deadlineSrc.includes(`APPLICATION_DEADLINE_ISO = '${EXPECTED_ISO}'`),
  `expected APPLICATION_DEADLINE_ISO = '${EXPECTED_ISO}' in ${DEADLINE_FILE}`
);
check(
  "deadline constant is parseable",
  !Number.isNaN(new Date(EXPECTED_ISO).getTime())
);

// (2) Closed-window copy matches the constant in every consumer file.
for (const rel of COPY_FILES) {
  const src = read(rel);
  check(`${rel} shows "${CLOSED_TITLE}"`, src.includes(CLOSED_TITLE));
  check(`${rel} shows "${EXPECTED_COPY}"`, src.includes(EXPECTED_COPY));
}

// (3) No stale "Oct 15" cutoff copy survives anywhere in the reapply/induction flow.
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(tsx?|jsx?|json|md)$/.test(entry)) yield full;
  }
}
for (const rel of STALE_SCAN_DIRS) {
  const hits = [];
  for (const full of walk(join(ROOT, rel))) {
    const text = readFileSync(full, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      if (line.includes(STALE_MARKER)) hits.push(`${full.replace(ROOT + "/", "")}:${i + 1}: ${line.trim()}`);
    }
  }
  check(`no "Oct 15" copy in ${rel}`, hits.length === 0, hits.join("; "));
}

for (const p of passes) console.log(`PASS ${p}`);
for (const f of failures) console.error(`FAIL ${f}`);
console.log(`\n${passes.length} passed, ${failures.length} failed.`);

if (failures.length > 0) {
  console.error("\nInduction cutoff mismatch. Fix the date copy to match the single source of truth in " + DEADLINE_FILE + ".");
  process.exit(1);
}
console.log("Induction cutoff guard: all checks green.");
