/**
 * Election certificate payload + signature tests. PDF rendering uses
 * jsPDF, whose dist is not transformable by this repo's jest config;
 * the signature logic (the part that binds the certificate) is pure
 * and tested here.
 */

import {
  certificatePayload,
  signCertificate,
  type ElectionCertificateData,
} from "../election-certificate-pdf";

const DATA: ElectionCertificateData = {
  electionId: "el-1",
  electionTitle: "Member Governor Election 2026",
  seats: 2,
  elected: [
    { candidateUid: "cand", name: "Candidate cand", votes: 3 },
    { candidateUid: "cand2", name: "Candidate cand2", votes: 2 },
  ],
  tallies: { cand: 3, cand2: 2, cand3: 2 },
  candidateNames: { cand: "Candidate cand", cand2: "Candidate cand2", cand3: "Candidate cand3" },
  tieLotId: "lot-1",
  returningOfficerName: "R Officer",
  returningOfficerUid: "ro-uid",
  declaredAtMillis: Date.UTC(2026, 11, 31, 20, 0),
  verificationUrl: "https://sedspakistan.live/elections/el-1",
};

describe("election certificate signature", () => {
  it("is deterministic for the same payload and salt", () => {
    expect(signCertificate(DATA, "salt-a")).toBe(signCertificate(DATA, "salt-a"));
    expect(signCertificate(DATA, "salt-a")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any bound field changes", () => {
    const base = signCertificate(DATA, "salt-a");
    expect(signCertificate({ ...DATA, tieLotId: null }, "salt-a")).not.toBe(base);
    expect(
      signCertificate(
        { ...DATA, elected: [{ candidateUid: "cand", name: "Candidate cand", votes: 4 }, DATA.elected[1]] },
        "salt-a",
      ),
    ).not.toBe(base);
    expect(signCertificate(DATA, "salt-b")).not.toBe(base);
  });

  it("payload is stable regardless of elected ordering", () => {
    const reordered = { ...DATA, elected: [...DATA.elected].reverse() };
    expect(certificatePayload(reordered)).toBe(certificatePayload(DATA));
  });

  it("fails closed when CERTIFICATE_SALT is missing", () => {
    const saved = process.env.CERTIFICATE_SALT;
    delete process.env.CERTIFICATE_SALT;
    try {
      expect(() => signCertificate(DATA)).toThrow(/CERTIFICATE_SALT/);
    } finally {
      if (saved !== undefined) process.env.CERTIFICATE_SALT = saved;
    }
  });
});
