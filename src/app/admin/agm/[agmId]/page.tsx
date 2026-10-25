"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useUser } from "@/firebase";
import AuthorizationGate from "@/components/admin/AuthorizationGate";
import { fmtDate } from "@/components/elections/api";
import {
  addAgmDocument,
  getAgm,
  getAgmNotice,
  issueAgmNotice,
  patchAgm,
} from "@/lib/elections/client-supa";
import AgmDocuments from "@/components/agm/agm-documents";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function AdminAgmDetailPage() {
  const { user } = useUser();
  const params = useParams();
  const agmId = String(params.agmId);
  const [agm, setAgm] = useState<any>(null);
  const [noticeInfo, setNoticeInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [docKind, setDocKind] = useState("audited_accounts");
  const [docTitle, setDocTitle] = useState("");
  const [docFileId, setDocFileId] = useState("");
  const [docLink, setDocLink] = useState("");
  const [docSha, setDocSha] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getAgm(user, agmId);
      setAgm(data.agm);
      const n = await getAgmNotice(user, agmId).catch(() => null);
      setNoticeInfo(n);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, [user, agmId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(run: () => Promise<unknown>) {
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice("Done.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    }
  }

  async function addElectionItem() {
    if (!agm) return;
    const agenda = [
      ...agm.agenda,
      {
        order: agm.agenda.length + 1,
        title: "Election of Member Governors",
        kind: "governor_election",
        electionId: agm.electionId ?? null,
        documentIds: [],
      },
    ];
    await call(() => patchAgm(user, agmId, { action: "update_agenda", agenda }));
  }

  const inputCls = "w-full rounded-md border bg-background px-3 py-2 text-sm";
  const btnCls = "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground";
  const btnGhost = "rounded-md border px-3 py-1.5 text-sm";

  return (
    <AuthorizationGate permission="canManageAgm">
      <div className="space-y-5 p-6">
        <div>
          <h1 className="text-2xl font-bold">{agm?.title ?? "AGM"}</h1>
          <p className="text-sm text-muted-foreground">
            Scheduled {fmtDate(agm?.scheduledAt)} - {agm?.locationOrLink} - status {agm?.status}
            {agm?.seatsDue ? " - Member Governor seats DUE" : ""}
          </p>
        </div>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {notice && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</p>}

        <section className="space-y-2">
          <h2 className="font-semibold">Agenda {agm?.agendaFinalised ? "(finalised)" : ""}</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {(agm?.agenda ?? []).map((item: any, i: number) => (
              <li key={i}>{item.title} <span className="text-muted-foreground">({item.kind})</span></li>
            ))}
          </ol>
          {!agm?.agendaFinalised && (
            <div className="flex gap-2">
              {!agm?.agenda?.some((i: any) => i.kind === "governor_election") && agm?.seatsDue && (
                <button className={btnGhost} onClick={addElectionItem}>Add Governor election item</button>
              )}
              <button className={btnCls} onClick={() => call(() => patchAgm(user, agmId, { action: "finalise_agenda" }))}>
                Finalise agenda
              </button>
            </div>
          )}
          {agm?.seatsDue && !agm?.agenda?.some((i: any) => i.kind === "governor_election") && (
            <p className="text-sm text-amber-700">
              Seats are due but the agenda has no Governor election item:
              finalisation and notice issue will return 422
              election_item_required.
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Notice and delivery proof</h2>
          {noticeInfo?.notice ? (
            <div className="text-sm">
              <p>
                Issued {fmtDate(noticeInfo.notice.issuedAt)} to{" "}
                {noticeInfo.notice.recipientSet?.recipientCount} Full Members
                (recipient set hash: <span className="break-all font-mono text-xs">{noticeInfo.notice.recipientSet?.recipientUidsHash}</span>).
              </p>
              <p>Delivery counts (in-app): {JSON.stringify(noticeInfo.deliveryCounts ?? {})}</p>
              {Array.isArray(noticeInfo.recipients) && (
                <ul className="mt-1 max-h-48 overflow-auto text-xs text-muted-foreground">
                  {noticeInfo.recipients.map((r: any) => (
                    <li key={r.id}>{r.displayName} - in-app {r.deliveryStatus?.inApp}, email {r.deliveryStatus?.email}, push {r.deliveryStatus?.push}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <button className={btnCls} onClick={() => call(() => issueAgmNotice(user, agmId))}>
              Issue 21-day notice
            </button>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Documents</h2>
          <AgmDocuments user={user} agmId={agmId} isFullMember={true} />
          <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
            <select value={docKind} onChange={(e) => setDocKind(e.target.value)} className={inputCls}>
              <option value="audited_accounts">Audited accounts (Full Members only)</option>
              <option value="audit_report">Audit report (Full Members only)</option>
              <option value="agenda">Agenda</option>
              <option value="notice">Notice</option>
              <option value="minutes">Minutes</option>
              <option value="other">Other</option>
            </select>
            <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="Title" className={inputCls} />
            <input value={docFileId} onChange={(e) => setDocFileId(e.target.value)} placeholder="Drive file ID (governance kind)" className={inputCls} />
            <input value={docLink} onChange={(e) => setDocLink(e.target.value)} placeholder="Drive link (never shown to non-Full Members)" className={inputCls} />
            <input value={docSha} onChange={(e) => setDocSha(e.target.value)} placeholder="SHA-256" className={inputCls} />
            <button className={btnCls} onClick={() => call(() => addAgmDocument(user, agmId, { kind: docKind, title: docTitle, driveFileId: docFileId, driveLink: docLink, fileName: docTitle, sha256: docSha, sourceModule: "manual_upload" }))}>
              Add document metadata
            </button>
          </div>
        </section>

        <section className="space-y-1 text-sm">
          <h2 className="font-semibold">Quorum</h2>
          <p>
            Basis: Full Members. Roll size {agm?.quorum?.rollSize}, required{" "}
            {agm?.quorum?.quorumRequired} (20 percent, Constitution 10.6),
            present {agm?.quorum?.presentCount ?? "not verified yet"}.
          </p>
        </section>
      </div>
    </AuthorizationGate>
  );
}
