'use client';

// Public governance documents page (Workstream D, spec 5.2). Data
// comes ONLY from GET /api/public/governance-documents; this page
// never reads Firestore. Publication is held behind
// GOVERNANCE_PUBLICATION_ENABLED (default OFF) until Zubair approves
// go-live: with the flag off the API returns no documents and this
// page shows the layer structure with "No documents published yet.",
// which is the honest state of the record.
// Status labels arrive from the API's fixed label table (spec 5.2
// item 4); the page renders them verbatim and invents none.

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FileText } from 'lucide-react';

interface PublicRecord {
  recordId: string;
  title: string;
  parties: string[];
  recordDate: string;
  version: number;
  adoptionLabel: string | null;
  effectiveLabel: string | null;
  fileUrl: string | null;
}

interface Registration {
  status: 'in_process' | 'registered';
  registrationNumber: string | null;
  registrationDate: string | null;
  registrarJurisdiction: string | null;
}

interface PublicPayload {
  layers: Record<string, PublicRecord[]>;
  unlayered: PublicRecord[];
  registration: Registration;
}

// Layer definitions from doc 01 R7 (Master Architecture 3.1-3.5),
// quoted by spec 5.2 item 2.
const LAYERS = [
  {
    key: '0',
    heading: 'Layer 0 - Filed with the Registrar',
    definition:
      'The Memorandum, the Constitution, and the Reserved Powers Schedule.',
  },
  {
    key: '1',
    heading: 'Layer 1 - Adopted by the Board of Governors',
    definition:
      'The Master Architecture, the Role Catalog, the Decision Rights Schedule, and the Finance, Related-Party and IP Policy.',
  },
  {
    key: '2',
    heading: 'Layer 2 - Controlled by the Founder',
    definition:
      'The SEDS Earth MOU, the Procedure Manual, and the Annual Compliance Calendar.',
  },
];

function DocumentRow({ record }: { record: PublicRecord }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border p-4">
      <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="font-medium">{record.title}</p>
        <p className="text-sm text-muted-foreground">
          {record.parties.length > 0 && <>{record.parties.join(', ')} - </>}
          {record.recordDate} - Version {record.version}
        </p>
      </div>
      <div className="flex gap-2">
        {record.adoptionLabel && <Badge variant="secondary">{record.adoptionLabel}</Badge>}
        {record.effectiveLabel && <Badge variant="outline">{record.effectiveLabel}</Badge>}
      </div>
      {record.fileUrl && (
        <div className="ml-auto flex gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={record.fileUrl} target="_blank" rel="noreferrer">View</a>
          </Button>
          <Button asChild size="sm">
            <a href={`${record.fileUrl}?download=1`}>Download</a>
          </Button>
        </div>
      )}
    </div>
  );
}

export default function GovernancePage() {
  const [payload, setPayload] = useState<PublicPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/api/public/governance-documents')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
      .then(setPayload)
      .catch(() => setFailed(true));
  }, []);

  const registrationLine = (() => {
    if (!payload) return null;
    const reg = payload.registration;
    if (reg.status === 'registered') {
      return `SEDS Pakistan is registered under the Societies Registration Act, 1860${reg.registrationNumber ? ` (registration number ${reg.registrationNumber}` : ''}${reg.registrationDate ? `, registered on ${reg.registrationDate}` : ''}${reg.registrationNumber ? ')' : ''}. Documents below are shown with their adoption status and their effective status.`;
    }
    // Spec 5.2 item 1: this exact line while registration is in process.
    return "SEDS Pakistan's registration under the Societies Registration Act, 1860 is in process. Documents below are shown with their adoption status and their effective status.";
  })();

  return (
    <div className="container mx-auto max-w-4xl py-12 px-4">
      <h1 className="text-4xl font-bold mb-4">Governance Documents</h1>
      <p className="text-muted-foreground mb-2">
        SEDS Pakistan is governed by the documents below: its constitution suite,
        its adopted policies, and the controlled instruments listed by layer.
      </p>
      {registrationLine && (
        <p className="mb-10 rounded-md bg-muted/50 p-3 text-sm">{registrationLine}</p>
      )}
      {failed && (
        <p className="text-sm text-muted-foreground">The document list could not be loaded right now.</p>
      )}

      {LAYERS.map((layer) => {
        const docs = payload?.layers[layer.key] || [];
        return (
          <section key={layer.key} className="mb-10">
            <h2 className="text-2xl font-semibold mb-1">{layer.heading}</h2>
            <p className="text-sm text-muted-foreground mb-4">{layer.definition}</p>
            {docs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No documents published yet.</p>
            ) : (
              <div className="space-y-3">
                {docs.map((r) => <DocumentRow key={r.recordId} record={r} />)}
              </div>
            )}
          </section>
        );
      })}

      {payload && payload.unlayered.length > 0 && (
        <section className="mb-10">
          <h2 className="text-2xl font-semibold mb-4">Additional documents</h2>
          <div className="space-y-3">
            {payload.unlayered.map((r) => <DocumentRow key={r.recordId} record={r} />)}
          </div>
        </section>
      )}
    </div>
  );
}
