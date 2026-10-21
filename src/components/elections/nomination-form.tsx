"use client";

import { useState } from "react";
import { electionsApi } from "./api";

/**
 * Nomination form (spec 5.3). Exactly 2 nominators from the frozen
 * roll, candidate statement, campaign code acceptance, and the
 * candidate's written consent already uploaded to Drive (kind
 * governance) with its SHA-256 recorded. Eligibility facts are
 * evaluated and stored server-side at submit; the RO decides (Sec 7.4).
 */
export default function NominationForm({
  user,
  electionId,
  onSubmitted,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
  electionId: string;
  onSubmitted?: () => void;
}) {
  const [candidateUid, setCandidateUid] = useState("");
  const [candidateName, setCandidateName] = useState("");
  const [nominator1, setNominator1] = useState("");
  const [nominator2, setNominator2] = useState("");
  const [statement, setStatement] = useState("");
  const [consentDriveFileId, setConsentDriveFileId] = useState("");
  const [consentSha256, setConsentSha256] = useState("");
  const [campaignCodeAccepted, setCampaignCodeAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await electionsApi(user, `/api/elections/${electionId}/nominations`, {
        method: "POST",
        body: JSON.stringify({
          candidateUid,
          candidateName,
          nominatorUids: [nominator1, nominator2],
          candidateStatement: statement,
          consentDriveFileId,
          consentSha256,
          campaignCodeAccepted,
        }),
      });
      setMessage("Nomination submitted. The Returning Officer verifies nominations within 3 days of close.");
      onSubmitted?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-md border bg-background px-3 py-2 text-sm";
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Candidate UID
          <input required value={candidateUid} onChange={(e) => setCandidateUid(e.target.value)} className={inputCls} />
        </label>
        <label className="text-sm">
          Candidate name
          <input required value={candidateName} onChange={(e) => setCandidateName(e.target.value)} className={inputCls} />
        </label>
        <label className="text-sm">
          Nominator 1 UID (roll member)
          <input required value={nominator1} onChange={(e) => setNominator1(e.target.value)} className={inputCls} />
        </label>
        <label className="text-sm">
          Nominator 2 UID (roll member)
          <input required value={nominator2} onChange={(e) => setNominator2(e.target.value)} className={inputCls} />
        </label>
      </div>
      <label className="block text-sm">
        Candidate statement (max 2000 characters)
        <textarea value={statement} onChange={(e) => setStatement(e.target.value)} maxLength={2000} rows={4} className={inputCls} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Consent Drive file ID (kind: governance)
          <input required value={consentDriveFileId} onChange={(e) => setConsentDriveFileId(e.target.value)} className={inputCls} />
        </label>
        <label className="text-sm">
          Consent file SHA-256
          <input required value={consentSha256} onChange={(e) => setConsentSha256(e.target.value)} className={inputCls} />
        </label>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={campaignCodeAccepted} onChange={(e) => setCampaignCodeAccepted(e.target.checked)} className="mt-1" />
        The candidate accepts the campaign code of conduct (Sec 7.5),
        including the undertaking not to use society funds.
      </label>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <button type="submit" disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {busy ? "Submitting..." : "Submit nomination"}
      </button>
    </form>
  );
}
