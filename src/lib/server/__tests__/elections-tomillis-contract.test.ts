/**
 * @jest-environment node
 *
 * F7 — CONVERTER CONTRACT for election-ports' toMillis (and
 * election-db's millisOf, which delegates to it), from the cron
 * cluster buildout.
 *
 * The defect: toMillis had NO string branch (and no `_seconds`
 * branch), so an election doc written through the Supabase adapter
 * — whose timetable fields are ISO strings in jsonb — read back as
 * 0 millis at every window gate, and a dumped
 * { _seconds, _nanoseconds } shape read as 0 too. The
 * elections-lifecycle cron route consumes this converter through
 * timetableToMillis (elections.ts), so a flipped elections surface
 * would have made every lifecycle window fire immediately.
 *
 * The contract pinned here: for one fixed instant, EVERY stored
 * shape of that instant converts to the IDENTICAL millis —
 * (a) ISO string (Z form and offset form), (b) the migration-kit's
 * dumped { _seconds, _nanoseconds } shape, (c) the live
 * { seconds, nanoseconds } shape, (d) a Timestamp-like
 * { toMillis() } object and the suites' FakeTimestamp, (e) a Date,
 * (f) the raw epoch number. And the pre-existing fall-through is
 * preserved: null / undefined / unparseable strings / unknown
 * object shapes return 0 — the new branches must not turn garbage
 * into a nonzero time.
 *
 * Sibling converters with the same contract surface are pinned
 * identically where they are exported/callable:
 *   - election-domain-supa.supaValueToMillis (number | null;
 *     garbage -> null is ITS fall-through contract)
 *   - agm-domain-supa.supaValueToMillis      (same)
 *   - src/lib/supa adapter timestampMillis   (dumped / Date /
 *     toMillis shapes only — it has no string/number branch by
 *     design, so ISO identity is NOT pinned there; noted in the
 *     F7 report)
 * election-supa.ts exports no value->millis converter (its
 * conversion is doc-level, fromSupaDoc), so there is nothing
 * callable to pin there.
 *
 * Zero live reads: pure converter calls only.
 */

jest.mock("firebase-admin", () =>
  require("./helpers/fake-firestore").fakeFirebaseAdminModule(),
);

jest.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => new Date() },
}));

jest.mock(
  "@supabase/supabase-js",
  () => ({ createClient: jest.fn(() => null) }),
  { virtual: true },
);

import { FakeTimestamp } from "./helpers/fake-firestore";
import { toMillis } from "../election-ports";
import { millisOf } from "../election-db";
import { timetableToMillis } from "../elections";
import { supaValueToMillis as domainSupaToMillis } from "../election-domain-supa";
import { supaValueToMillis as agmSupaToMillis } from "../agm-domain-supa";
import { timestampMillis } from "../../supa/adapter";
import type { ElectionTimetable } from "@/types/elections";

// ---------------------------------------------------------------------------
// One fixed instant, in every stored shape.
// 2026-11-15T06:00:00.000Z == 2026-11-15T11:00:00.000+05:00
// ---------------------------------------------------------------------------

const MS = Date.UTC(2026, 10, 15, 6, 0, 0);
const SECONDS = MS / 1000;
const ISO_Z = "2026-11-15T06:00:00.000Z";
const ISO_OFFSET = "2026-11-15T11:00:00.000+05:00";

// Same instant + 123 ms, for the nanosecond-contribution pins.
const MS2 = MS + 123;
const ISO_Z_SUB = "2026-11-15T06:00:00.123Z";

const SHAPES: Array<[string, unknown]> = [
  ["ISO string (Z)", ISO_Z],
  ["ISO string (+05:00 offset, same instant)", ISO_OFFSET],
  ["dumped { _seconds, _nanoseconds }", { _seconds: SECONDS, _nanoseconds: 0 }],
  ["live { seconds, nanoseconds }", { seconds: SECONDS, nanoseconds: 0 }],
  ["Timestamp-like { toMillis() }", { toMillis: () => MS }],
  ["FakeTimestamp (suite Timestamp)", FakeTimestamp.fromMillis(MS)],
  ["Date", new Date(MS)],
  ["raw epoch number", MS],
];

// ---------------------------------------------------------------------------

describe("F7 toMillis / millisOf: every shape of one instant converts identically", () => {
  it("the fixture instant is the one the ISO strings denote", () => {
    expect(new Date(ISO_Z).getTime()).toBe(MS);
    expect(new Date(ISO_OFFSET).getTime()).toBe(MS);
    expect(ISO_Z).toBe(new Date(MS).toISOString());
  });

  for (const [label, value] of SHAPES) {
    it(`toMillis(${label}) === ${MS}`, () => {
      expect(toMillis(value)).toBe(MS);
    });
    it(`millisOf(${label}) === ${MS} (delegation is identical)`, () => {
      expect(millisOf(value)).toBe(MS);
    });
  }

  it("sub-second precision survives: nanoseconds contribute their millis in every shape that carries them", () => {
    expect(toMillis(ISO_Z_SUB)).toBe(MS2);
    expect(toMillis({ _seconds: SECONDS, _nanoseconds: 123_000_000 })).toBe(MS2);
    expect(toMillis({ seconds: SECONDS, nanoseconds: 123_000_000 })).toBe(MS2);
    expect(toMillis(FakeTimestamp.fromMillis(MS2))).toBe(MS2);
    expect(toMillis(new Date(MS2))).toBe(MS2);
    expect(toMillis(MS2)).toBe(MS2);
    expect(millisOf({ _seconds: SECONDS, _nanoseconds: 123_000_000 })).toBe(MS2);
  });
});

describe("F7 toMillis / millisOf: preserved fall-through (garbage is 0, never a nonzero time)", () => {
  const GARBAGE: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["unparseable string", "not-a-date"],
    ["empty string", ""],
    ["ISO-shaped but invalid date", "2026-13-45T99:99:99.000Z"],
    ["plain object", {}],
    ["unknown object shape", { foo: 1 }],
    ["nanoseconds without seconds", { nanoseconds: 500_000_000 }],
    ["string seconds (not a stored shape)", { seconds: String(SECONDS) }],
    ["array", []],
    ["boolean", true],
  ];

  for (const [label, value] of GARBAGE) {
    it(`toMillis(${label}) === 0 and millisOf(${label}) === 0`, () => {
      expect(toMillis(value)).toBe(0);
      expect(millisOf(value)).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Timetable-level pin: the converter path the lifecycle/window gates
// actually use (elections.ts timetableToMillis -> millisOf).
// ---------------------------------------------------------------------------

function makeTimetable(
  stamp: (millis: number) => unknown,
): ElectionTimetable {
  const at = (offsetMs: number) => stamp(MS + offsetMs) as never;
  return {
    electionDay: at(0),
    timetablePublishedAt: at(-30 * 24 * 3600 * 1000),
    timetableLateReason: null,
    nominationOpenAt: at(-20 * 24 * 3600 * 1000),
    nominationCloseAt: at(-10 * 24 * 3600 * 1000),
    vettingDeadlineAt: at(-9 * 24 * 3600 * 1000),
    candidateListDate: at(-7 * 24 * 3600 * 1000),
    candidateListPublishedAt: at(-7 * 24 * 3600 * 1000),
    pollOpenAt: at(0),
    pollCloseAt: at(12 * 3600 * 1000),
    challengeWindowClosesAt: at(3 * 24 * 3600 * 1000),
    certificateDeadlineAt: at(10 * 24 * 3600 * 1000),
  } as ElectionTimetable;
}

describe("F7 timetable-level: ISO vs dumped timetables yield identical window millis", () => {
  const isoTimetable = makeTimetable((ms) => new Date(ms).toISOString());
  const dumpedTimetable = makeTimetable((ms) => ({
    _seconds: Math.floor(ms / 1000),
    _nanoseconds: (ms % 1000) * 1_000_000,
  }));
  const liveTimetable = makeTimetable((ms) => FakeTimestamp.fromMillis(ms));

  it("pollOpenAt / pollCloseAt are the true window millis in BOTH representations (never 0)", () => {
    for (const tt of [isoTimetable, dumpedTimetable, liveTimetable]) {
      const tm = timetableToMillis(tt);
      expect(tm.pollOpenAt).toBe(MS);
      expect(tm.pollCloseAt).toBe(MS + 12 * 3600 * 1000);
      expect(tm.electionDay).toBe(MS);
      expect(tm.nominationOpenAt).toBe(MS - 20 * 24 * 3600 * 1000);
    }
  });

  it("the full converted timetables are deep-identical across representations", () => {
    expect(timetableToMillis(isoTimetable)).toEqual(
      timetableToMillis(dumpedTimetable),
    );
    expect(timetableToMillis(liveTimetable)).toEqual(
      timetableToMillis(dumpedTimetable),
    );
  });

  it("a MIXED-shape timetable (adapter doc: some ISO, some dumped, some live) converts identically too", () => {
    const mixed = makeTimetable((ms) => new Date(ms).toISOString());
    const dumped = dumpedTimetable as unknown as Record<string, unknown>;
    const mixedRec = mixed as unknown as Record<string, unknown>;
    mixedRec.pollCloseAt = dumped.pollCloseAt;
    mixedRec.nominationCloseAt = dumped.nominationCloseAt;
    expect(timetableToMillis(mixed)).toEqual(timetableToMillis(dumpedTimetable));
  });
});

// ---------------------------------------------------------------------------
// Sibling converters (exported/callable ones), same identity contract
// in their own return convention (number | null; garbage -> null).
// ---------------------------------------------------------------------------

describe("F7 sibling: election-domain-supa supaValueToMillis", () => {
  for (const [label, value] of SHAPES) {
    it(`(${label}) === ${MS}`, () => {
      expect(domainSupaToMillis(value)).toBe(MS);
    });
  }

  it("sub-second dumped shape keeps its 123 ms", () => {
    expect(
      domainSupaToMillis({ _seconds: SECONDS, _nanoseconds: 123_000_000 }),
    ).toBe(MS2);
    expect(domainSupaToMillis(ISO_Z_SUB)).toBe(MS2);
  });

  it("toDate-like objects convert; garbage and null fall through to null (its contract)", () => {
    expect(domainSupaToMillis({ toDate: () => new Date(MS) })).toBe(MS);
    expect(domainSupaToMillis("not-a-date")).toBeNull();
    expect(domainSupaToMillis(null)).toBeNull();
    expect(domainSupaToMillis(undefined)).toBeNull();
    expect(domainSupaToMillis({ foo: 1 })).toBeNull();
  });
});

describe("F7 sibling: agm-domain-supa supaValueToMillis", () => {
  for (const [label, value] of SHAPES) {
    it(`(${label}) === ${MS}`, () => {
      expect(agmSupaToMillis(value)).toBe(MS);
    });
  }

  it("sub-second dumped shape keeps its 123 ms", () => {
    expect(
      agmSupaToMillis({ _seconds: SECONDS, _nanoseconds: 123_000_000 }),
    ).toBe(MS2);
    expect(agmSupaToMillis(ISO_Z_SUB)).toBe(MS2);
  });

  it("toDate-like objects convert; garbage and null fall through to null (its contract)", () => {
    expect(agmSupaToMillis({ toDate: () => new Date(MS) })).toBe(MS);
    expect(agmSupaToMillis("not-a-date")).toBeNull();
    expect(agmSupaToMillis(null)).toBeNull();
    expect(agmSupaToMillis(undefined)).toBeNull();
    expect(agmSupaToMillis({ foo: 1 })).toBeNull();
  });
});

describe("F7 sibling: supa adapter timestampMillis (stored-shape converter; no string/number branch by design)", () => {
  it("dumped / Date / Timestamp-like shapes of the instant convert identically", () => {
    expect(timestampMillis({ _seconds: SECONDS, _nanoseconds: 0 })).toBe(MS);
    expect(
      timestampMillis({ _seconds: SECONDS, _nanoseconds: 123_000_000 }),
    ).toBe(MS2);
    expect(timestampMillis(new Date(MS))).toBe(MS);
    expect(timestampMillis({ toMillis: () => MS })).toBe(MS);
    expect(timestampMillis(FakeTimestamp.fromMillis(MS))).toBe(MS);
  });

  it("garbage falls through to null (its contract)", () => {
    expect(timestampMillis(null)).toBeNull();
    expect(timestampMillis(undefined)).toBeNull();
    expect(timestampMillis({ foo: 1 })).toBeNull();
  });
});
