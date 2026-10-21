import {
  deriveTimetable,
  validateTimetable,
  vettingDeadline,
  certificateDeadline,
  timetablePublicationDeadline,
  DAY_MS,
} from "../timetable";

// 31 December 2026 (the worked example in spec Section 3.2).
const ELECTION_DAY = Date.UTC(2026, 11, 31);

describe("elections timetable", () => {
  it("derives the spec worked example for a 31 Dec 2026 election", () => {
    const tt = deriveTimetable(ELECTION_DAY);
    expect(tt.nominationOpenAt).toBe(Date.UTC(2026, 11, 10));
    expect(tt.nominationCloseAt).toBe(Date.UTC(2026, 11, 24));
    expect(tt.vettingDeadlineAt).toBe(Date.UTC(2026, 11, 27));
    expect(timetablePublicationDeadline(ELECTION_DAY)).toBe(Date.UTC(2026, 11, 1));
    expect(validateTimetable(tt).valid).toBe(true);
  });

  it("1. rejects nominationOpenAt later than electionDay minus 21 days", () => {
    const tt = deriveTimetable(ELECTION_DAY);
    tt.nominationOpenAt = ELECTION_DAY - 20 * DAY_MS;
    const v = validateTimetable(tt);
    expect(v.valid).toBe(false);
    expect(v.violations.some((x) => x.field === "nominationOpenAt")).toBe(true);
  });

  it("2. rejects nominationCloseAt later than electionDay minus 7 days", () => {
    const tt = deriveTimetable(ELECTION_DAY);
    tt.nominationCloseAt = ELECTION_DAY - 6 * DAY_MS;
    tt.vettingDeadlineAt = vettingDeadline(tt.nominationCloseAt);
    const v = validateTimetable(tt);
    expect(v.valid).toBe(false);
    expect(v.violations.some((x) => x.field === "nominationCloseAt")).toBe(true);
  });

  it("3. rejects T-30-late publication without a late reason; accepts with one and flags the miss", () => {
    const tt = deriveTimetable(ELECTION_DAY);
    tt.timetablePublishedAt = Date.UTC(2026, 11, 5); // after 1 Dec deadline

    const without = validateTimetable(tt);
    expect(without.valid).toBe(false);
    expect(without.violations.some((x) => x.rule === "T-30")).toBe(true);
    expect(without.publicationMissFlagged).toBe(false);

    const withReason = validateTimetable(tt, {
      publicationLateReason: "Board confirmed the date late",
    });
    expect(withReason.valid).toBe(true);
    expect(withReason.publicationMissFlagged).toBe(true);
  });

  it("accepts publication exactly on the T-30 deadline", () => {
    const tt = deriveTimetable(ELECTION_DAY);
    tt.timetablePublishedAt = timetablePublicationDeadline(ELECTION_DAY);
    expect(validateTimetable(tt).valid).toBe(true);
  });

  it("4. derives vettingDeadlineAt as nominationCloseAt plus 3 days", () => {
    const close = Date.UTC(2026, 11, 24);
    expect(vettingDeadline(close)).toBe(Date.UTC(2026, 11, 27));
    const tt = deriveTimetable(ELECTION_DAY);
    tt.vettingDeadlineAt = close + 2 * DAY_MS;
    const v = validateTimetable(tt);
    expect(v.violations.some((x) => x.field === "vettingDeadlineAt")).toBe(true);
  });

  it("4b. derives certificateDeadlineAt as count end plus 24 hours", () => {
    const countEnd = Date.UTC(2026, 11, 31, 18, 30);
    expect(certificateDeadline(countEnd)).toBe(countEnd + 24 * 60 * 60 * 1000);
  });
});
