"use client";

import { useCallback, useEffect, useState } from "react";
import { electionsApi } from "./api";

interface AgmDocumentView {
  id: string;
  kind: string;
  title: string;
  fileName: string;
  fullMembersOnly: boolean;
  driveLink: string | null;
  sourceModule: string;
}

/**
 * AGM documents list (spec 5.3). Every item resolves through the API,
 * never a stored public URL. Full-Member-only documents (audited
 * accounts, audit report) simply do not appear for Basic Members; the
 * section explains that state instead of showing a broken link.
 */
export default function AgmDocuments({
  user,
  agmId,
  isFullMember,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
  agmId: string;
  isFullMember: boolean | null;
}) {
  const [docs, setDocs] = useState<AgmDocumentView[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const data = await electionsApi<{ documents: AgmDocumentView[] }>(
        user,
        `/api/agm/${agmId}/documents`,
      );
      setDocs(data.documents);
    } catch {
      setDocs([]);
    } finally {
      setLoaded(true);
    }
  }, [user, agmId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading documents...</p>;

  return (
    <div className="space-y-2">
      {docs.length === 0 && (
        <p className="text-sm text-muted-foreground">No documents published yet.</p>
      )}
      {docs.map((d) => (
        <div key={d.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <span>
            <span className="font-medium">{d.title}</span>{" "}
            <span className="text-muted-foreground">({d.kind.replace(/_/g, " ")})</span>
            {d.sourceModule === "manual_upload" && (
              <span className="text-muted-foreground"> - interim manual upload</span>
            )}
          </span>
          {d.driveLink ? (
            <a href={d.driveLink} target="_blank" rel="noreferrer" className="underline">
              Open
            </a>
          ) : (
            <span className="text-muted-foreground">Full Members only</span>
          )}
        </div>
      ))}
      {isFullMember === false && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          Full Members only: the audited accounts and the audit report
          for this AGM are served to Full Members. Basic Members do not
          see those documents or their links.
        </p>
      )}
    </div>
  );
}
