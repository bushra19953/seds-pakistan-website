/**
 * @jest-environment node
 *
 * B2-1 parent_path consistency contracts (STATIC — reads sources, no DB).
 *
 * Finding B2-1: tx_elections_cast_ballot.sql derived ONE parent value
 * ('elections/' || p_election_id) for three DIFFERENT subcollections,
 * while the kit (migrate_db.js rowFor()), the adapter
 * (resolveTarget()/writeRow()) and every seam store the FULL
 * subcollection path ('elections/<id>/ballots', '.../cast_markers',
 * '.../eligibility_tokens'). The mocked tx contracts modeled both
 * sides with one fake, so nothing caught it. These contracts read the
 * REAL SQL files and the REAL seam/adapter sources and assert the two
 * sides agree, per function x table — this defect class can never
 * hide behind a shared mock again.
 *
 * The convention under test (adapter.ts, the majority truth):
 *  - top-level collection 'X'      -> parent_path = 'X'
 *    (resolveTarget: parentPath = segments[0]; writeRow: doc path
 *    minus its last segment)
 *  - subcollection 'A/<id>/B'       -> parent_path = 'A/<id>/B' (the
 *    FULL collection path; resolveTarget: segments.join('/')),
 *    landing in table fs_group_B.
 *
 * Rules enforced for EVERY parent_path write/read in src/lib/supa/sql/
 * (tx-template.sql excluded: it is the authoring template, not a
 * function):
 *  R1 top-level table fs_<c>   -> parent expr is exactly '<c>'.
 *  R2 group table fs_group_<s> -> parent expr is the owning seam's
 *     full-path template for that subcollection (table below), i.e.
 *     it ENDS in '/<s>' — a bare parent ('elections/<id>') fails.
 *  R3 the one dynamic insert (finance decide destination_change,
 *     insert into %I) -> its parent argument is the
 *     settings/pages case paired with fs_settings/fs_pages.
 *  R4 every `parent_path = <expr>` filter resolves to the same value
 *     as the write for its statement's table.
 * Completeness: the sweep enumerates inserts/filters mechanically
 * from the SQL text, so a NEW parent_path usage in any file is
 * checked by construction (an unmapped group table fails R2).
 */

import * as fs from 'fs';
import * as path from 'path';

const sqlDir = path.join(__dirname, '..', 'sql');
const readSql = (f: string) => fs.readFileSync(path.join(sqlDir, f), 'utf8');
const readSrc = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', rel), 'utf8');

const sqlFiles = fs
  .readdirSync(sqlDir)
  .filter((f) => f.endsWith('.sql') && f !== 'tx-template.sql')
  .sort();

/* ------------------------------------------------------------ parsing */

function varDecls(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of sql.matchAll(/(\w+)\s+text\s*:=\s*([^;]+);/g)) {
    map.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  }
  return map;
}

const resolve = (expr: string, decls: Map<string, string>): string =>
  decls.get(expr.trim()) ?? expr.replace(/\s+/g, ' ').trim();

/** Split the tuple after `values (` at top-level commas (string/paren aware). */
function splitTuple(sql: string, fromIdx: number): string[] {
  const start = sql.indexOf('(', fromIdx);
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (inStr) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cur += sql[++i];
        } else inStr = false;
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      if (depth > 1) cur += ch;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        parts.push(cur.replace(/\s+/g, ' ').trim());
        return parts;
      }
      cur += ch;
    } else if (ch === ',' && depth === 1) {
      parts.push(cur.replace(/\s+/g, ' ').trim());
      cur = '';
    } else cur += ch;
  }
  return parts;
}

interface ParentInsert {
  table: string;
  parentExpr: string; // resolved
}

function parentInserts(sql: string): ParentInsert[] {
  const decls = varDecls(sql);
  const out: ParentInsert[] = [];
  for (const m of sql.matchAll(
    /insert into\s+(\S+)\s*\(id, firebase_uid, parent_path, data\)/g,
  )) {
    const valuesAt = sql.indexOf('values', m.index + m[0].length);
    const parts = splitTuple(sql, valuesAt);
    out.push({ table: m[1], parentExpr: resolve(parts[2] ?? '', decls) });
  }
  return out;
}

interface ParentFilter {
  table: string;
  parentExpr: string;
}

function parentFilters(sql: string): ParentFilter[] {
  const decls = varDecls(sql);
  const out: ParentFilter[] = [];
  let lastTable = '';
  const re =
    /(?:from|update|delete from)\s+(fs_\w+)|parent_path\s*=\s*([^\s;]+)/g;
  for (const m of sql.matchAll(re)) {
    if (m[1]) lastTable = m[1];
    else if (m[2]) out.push({ table: lastTable, parentExpr: resolve(m[2], decls) });
  }
  return out;
}

/* ------------------------------------------------- seam-side templates */

/**
 * Full-path SQL templates per group table, keyed by the seam that owns
 * the subcollection. The id placeholder differs per function
 * (p_event_id / v_event_id / p_election_id / p_vote_id), so templates
 * are regexes over the SQL concat expression.
 */
const GROUP_TEMPLATES: Array<{ table: string; re: RegExp; seam: string }> = [
  {
    table: 'fs_group_registrations',
    re: /^'events\/' \|\| \w+ \|\| '\/registrations'$/,
    seam: "registrations.ts / admin-events.ts: `events/${eventId}/registrations`",
  },
  {
    table: 'fs_group_ballots', // motions arm
    re: /^'governance_votes\/' \|\| \w+ \|\| '\/ballots'$/,
    seam: "governance-votes.ts ballotsPath(): `governance_votes/${voteId}/ballots`",
  },
  {
    table: 'fs_group_ballots', // elections arm (same table, disjoint namespace)
    re: /^'elections\/' \|\| \w+ \|\| '\/ballots'$/,
    seam: "election-domain-supa.ts subcollectionPath(): `elections/${id}/ballots`",
  },
  {
    table: 'fs_group_cast_markers',
    re: /^'elections\/' \|\| \w+ \|\| '\/cast_markers'$/,
    seam: "election-domain-supa.ts subcollectionPath(): `elections/${id}/cast_markers`",
  },
  {
    table: 'fs_group_eligibility_tokens',
    re: /^'elections\/' \|\| \w+ \|\| '\/eligibility_tokens'$/,
    seam: "election-domain-supa.ts subcollectionPath(): `elections/${id}/eligibility_tokens`",
  },
];

function groupTemplateMatches(table: string, expr: string): boolean {
  return GROUP_TEMPLATES.filter((t) => t.table === table).some((t) =>
    t.re.test(expr),
  );
}

/* ---------------------------------------------------------------- tests */

describe('adapter convention (the ground truth both sides must meet)', () => {
  const adapter = readSrc('src/lib/supa/adapter.ts');
  it('subcollection parentPath is the FULL joined path; top-level is segments[0]; writeRow drops only the doc id', () => {
    expect(adapter).toContain("parentPath: segments.join('/')");
    expect(adapter).toContain('parentPath: segments[0]');
    expect(adapter).toContain("segments.slice(0, -1).join('/')");
  });
});

describe('seam-side full-path templates exist in the owning seams', () => {
  it('elections seam addresses subcollections by elections/<id>/<sub> and the ballot code names all three subs', () => {
    const seam = readSrc('src/lib/server/election-domain-supa.ts');
    expect(seam).toContain('return `elections/${electionId}/${sub}`;');
    const ballot = readSrc('src/lib/server/election-ballot.ts');
    for (const sub of ['eligibility_tokens', 'cast_markers', 'ballots']) {
      expect(ballot).toContain(`"${sub}"`);
    }
  });
  it('motions seam ballotsPath is governance_votes/<id>/ballots', () => {
    expect(readSrc('src/lib/server/governance-votes.ts')).toContain(
      'return `governance_votes/${voteId}/ballots`;',
    );
  });
  it('events seams address registrations as events/<id>/registrations', () => {
    expect(readSrc('src/lib/supa-events/registrations.ts')).toContain(
      '`events/${eventId}/registrations`',
    );
    expect(readSrc('src/lib/supa-events/admin-events.ts')).toContain(
      'return `events/${eventId}/registrations`;',
    );
  });
});

describe('SQL side: every parent_path write/read agrees with the convention', () => {
  it('sweep is non-empty (files and usages were actually found)', () => {
    expect(sqlFiles.length).toBeGreaterThanOrEqual(24);
    const total = sqlFiles.reduce(
      (n, f) => n + parentInserts(readSql(f)).length + parentFilters(readSql(f)).length,
      0,
    );
    expect(total).toBeGreaterThan(40);
  });

  for (const file of sqlFiles) {
    describe(file, () => {
      const sql = readSql(file);
      const inserts = parentInserts(sql);
      const filters = parentFilters(sql);

      for (const ins of inserts) {
        it(`insert into ${ins.table}: parent = ${ins.parentExpr}`, () => {
          if (ins.table === '%I') {
            // R3: dynamic destination_change insert — parent is $2,
            // bound to the settings/pages case in the USING clause.
            expect(ins.parentExpr).toBe('$2');
            expect(sql).toContain(
              "case when v_table = 'fs_settings' then 'settings' else 'pages' end",
            );
            return;
          }
          if (ins.table.startsWith('fs_group_')) {
            // R2: full subcollection path per the owning seam.
            expect(groupTemplateMatches(ins.table, ins.parentExpr)).toBe(true);
            return;
          }
          // R1: top-level — parent is exactly the collection name.
          expect(ins.parentExpr).toBe(`'${ins.table.slice(3)}'`);
        });
      }

      for (const flt of filters) {
        it(`filter on ${flt.table}: parent = ${flt.parentExpr}`, () => {
          expect(flt.table.startsWith('fs_group_')).toBe(true);
          expect(groupTemplateMatches(flt.table, flt.parentExpr)).toBe(true);
        });
      }
    });
  }
});

describe('B2-1 regression pin (tx_elections_cast_ballot)', () => {
  const sql = readSql('tx_elections_cast_ballot.sql');
  it('no single bare elections/<id> parent serves all three subcollections', () => {
    expect(sql).not.toContain("v_parent text := 'elections/' || p_election_id;");
    const parents = new Set(parentInserts(sql).map((i) => i.parentExpr));
    expect(parents.size).toBe(2); // markers + ballots inserts (tokens are read/update only)
    for (const p of parents) expect(p).toMatch(/\|\| '\/(ballots|cast_markers)'$/);
  });
  it('token, marker and ballot usages each carry their own subcollection suffix', () => {
    expect(sql).toContain("'elections/' || p_election_id || '/eligibility_tokens'");
    expect(sql).toContain("'elections/' || p_election_id || '/cast_markers'");
    expect(sql).toContain("'elections/' || p_election_id || '/ballots'");
  });
});
