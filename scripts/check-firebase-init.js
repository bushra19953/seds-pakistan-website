#!/usr/bin/env node
// Simple guard: fail build if `initializeFirestore(` appears anywhere in src/ or functions/
// This prevents reintroducing the conflicting Firestore initialization in production.

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const TARGET_DIRS = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'functions'),
];
const IGNORE_DIRS = new Set(['node_modules', '.next', '.turbo', 'dist', 'out']);
const PATTERN = 'initializeFirestore('; // exact token

/**
 * Recursively collect files in a directory.
 */
function collectFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) collectFiles(fullPath, files);
    } else {
      // Only scan code files
      if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function scanFiles(files) {
  const offenders = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes(PATTERN)) {
        offenders.push(file);
      }
    } catch (err) {
      // ignore read errors
    }
  }
  return offenders;
}

function main() {
  const files = TARGET_DIRS.flatMap((d) => collectFiles(d));
  const offenders = scanFiles(files);
  if (offenders.length > 0) {
    console.error('\n[Guard] Disallowed Firestore initialization detected: initializeFirestore()');
    console.error('This can cause production crashes due to conflicting options.');
    console.error('Use getFirestore(app) or the exported firestore instance from src/firebase.');
    console.error('\nFiles:');
    for (const f of offenders) {
      console.error(' - ' + path.relative(ROOT, f));
    }
    console.error('\nFix the above occurrences and rerun the build.');
    process.exit(1);
  } else {
    console.log('[Guard] OK: No initializeFirestore() usage found.');
  }
}

main();

