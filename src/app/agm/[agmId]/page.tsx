"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useUser } from "@/firebase";
import { fmtDate } from "@/components/elections/api";
import { getAgm, getAgmDocuments, getAgmNotice } from "@/lib/elections/client-supa";
import { AgmStatusBadge } from "@/components/elections/status-badge";
import AgmDocuments from "@/components/agm/agm-documents";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function MemberAgmDetailPage() {
  const { user } = useUser();
  const params = useParams();
  const agmId = String(params.agmId);
  const [agm, setAgm] = useState<any>(null);
  const [noticeInfo, setNoticeInfo] = useState<any>(null);
  const [isFullMember, setIsFullMember] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getAgm(user, agmId);
      setAgm(data.agm);
      const n = await getAgmNotice(user, agmId).catch(() => null);
      setNoticeInfo(n);
      // Full Member state is inferred from document visibility: gated
      // docs are listed by the API only for Full Members. A direct
      // attempt on one document is the honest check the API offers.
      const docs = await getAgmDocuments(user, agmId).catch(() => ({ documents: [] as any[] }));
      setIsFullMember(docs.documents.some((d) => d.driveLink) ? true : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, [user, agmId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!user) return <div className="p-6 text-sm">Sign in to view this AGM.</div>;
  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!agm) return <div className="p-6 text-sm">Loading...</div>;

  const servedAgenda = noticeInfo?.notice?.agendaSnapshot ?? agm.agenda;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Link href="/agm" className="text-sm underline">All AGMs</Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="text-2xl font-bold">{agm.title}</h1>
          <AgmStatusBadge status={agm.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {fmtDate(agm.scheduledAt)} - {agm.locationOrLink}
        </p>
      </div>

      {noticeInfo?.notice ? (
        <section className="space-y-2">
          <h2 className="font-semibold">Notice as served</h2>
          <p className="text-sm text-muted-foreground">
            Issued {fmtDate(noticeInfo.notice.issuedAt)} to{" "}
            {noticeInfo.notice.recipientSet?.recipientCount} Full Members.
            The agenda below is the served snapshot; later agenda edits
            do not rewrite it.
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {(servedAgenda ?? []).map((item: any, i: number) => (
              <li key={i}>{item.title} <span className="text-muted-foreground">({item.kind})</span></li>
            ))}
          </ol>
        </section>
      ) : (
        <section className="space-y-2">
          <h2 className="font-semibold">Agenda</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {(agm.agenda ?? []).map((item: any, i: number) => (
              <li key={i}>{item.title} <span className="text-muted-foreground">({item.kind})</span></li>
            ))}
          </ol>
          <p className="text-sm text-muted-foreground">The 21-day notice has not been issued yet.</p>
        </section>
      )}

      {agm.seatsDue && agm.electionId && (
        <section className="rounded-md border p-3 text-sm">
          Member Governor seats are due at this AGM.{" "}
          <Link href={`/elections/${agm.electionId}`} className="underline">
            Open the election
          </Link>{" "}
          for the timetable, certified candidates and the ballot. The
          AGM is the occasion; the ballot itself runs through the
          election, not the meeting.
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">Documents</h2>
        <AgmDocuments user={user} agmId={agmId} isFullMember={isFullMember} />
      </section>

      <section className="space-y-1 text-sm">
        <h2 className="font-semibold">Quorum</h2>
        <p className="text-muted-foreground">
          General Body business requires 20 percent of Full Members
          (Constitution 10.6): {agm.quorum?.quorumRequired} of{" "}
          {agm.quorum?.rollSize}.
        </p>
      </section>
    </div>
  );
}
