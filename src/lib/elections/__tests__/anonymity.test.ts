import {
  generateBallotToken,
  hashBallotToken,
  castMarkerId,
} from "../anonymity";

const PEPPER = "test-pepper-test-pepper-0123456789";

describe("elections anonymity helpers", () => {
  it("9A. hashBallotToken is one-way SHA-256: output never equals the token and differs across elections", () => {
    const token = generateBallotToken();
    const h1 = hashBallotToken(token, "election-a");
    const h2 = hashBallotToken(token, "election-b");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(token);
    expect(h1).not.toContain(token);
    expect(h1).not.toBe(h2);
    // Deterministic for the same token + election (redemption lookup works).
    expect(hashBallotToken(token, "election-a")).toBe(h1);
  });

  it("generates distinct 32-byte base64url tokens", () => {
    const a = generateBallotToken();
    const b = generateBallotToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("10A. castMarkerId is stable per uid+election and differs across elections", () => {
    const m1 = castMarkerId("election-a", "uid-1", PEPPER);
    expect(castMarkerId("election-a", "uid-1", PEPPER)).toBe(m1);
    expect(castMarkerId("election-b", "uid-1", PEPPER)).not.toBe(m1);
    expect(castMarkerId("election-a", "uid-2", PEPPER)).not.toBe(m1);
    // The marker id itself carries no uid substring.
    expect(m1).not.toContain("uid-1");
  });

  it("fails closed when the pepper is missing", () => {
    const saved = process.env.ELECTION_MARKER_PEPPER;
    delete process.env.ELECTION_MARKER_PEPPER;
    try {
      expect(() => castMarkerId("election-a", "uid-1")).toThrow(/ELECTION_MARKER_PEPPER/);
    } finally {
      if (saved !== undefined) process.env.ELECTION_MARKER_PEPPER = saved;
    }
  });
});
