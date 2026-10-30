import { NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { getRegistrationStatus } from '@/lib/governance/registration-status';
import { isGovernancePublicationEnabled } from '@/lib/governance/publication';
import { isPublishable } from '@/lib/governance/redaction-guard';
import {
  GOVERNANCE_COLLECTION,
  toGovernanceRecord,
} from '@/lib/governance/record-io';
import type {
  AdoptionStatus,
  EffectiveStatus,
  GovernanceRecord,
} from '@/lib/governance/types';
import {
  PUBLIC_STALE_CACHE_CONTROL,
  getLastGoodPublic,
  rememberLastGoodPublic,
} from '@/lib/server/public-stale-cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Fixed label table (spec 5.2). These strings are product copy locked by
// the spec; they are never derived from record data.
const ADOPTION_LABELS: Record<AdoptionStatus, string | null> = {
  not_adopted: 'Not yet adopted',
  adopted_pending_execution: 'Adopted - pending execution (unsigned)',
  adopted_executed: 'Adopted',
  not_applicable: null,
};

const EFFECTIVE_LABELS: Record<EffectiveStatus, string | null> = {
  not_in_force_pending_registration:
    'Not in force - takes effect on registration',
  in_force: 'In force',
  not_applicable: null,
};

// Sanitised projection ONLY (spec 4.5). No drive ids or URLs, no hash,
// no uploader, no consent id, no notes, no links ever cross this route.
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

function toPublicRecord(record: GovernanceRecord): PublicRecord {
  return {
    recordId: record.recordId,
    title: record.title,
    parties: record.parties,
    recordDate: record.recordDate,
    version: record.version,
    adoptionLabel: ADOPTION_LABELS[record.adoptionStatus] ?? null,
    effectiveLabel: EFFECTIVE_LABELS[record.effectiveStatus] ?? null,
    fileUrl: record.driveFileId
      ? `/api/governance-records/${record.recordId}/file`
      : null,
  };
}

const STALE_KEY = 'public/governance-documents';

// Founder shelter (2026-10-30 outage follow-up): this payload is
// public, sanitised by the projection + redaction guard above, and
// slow-changing, so it gets the site-state treatment - successful
// responses carry s-maxage + stale-while-revalidate, and a failed
// read (e.g. RESOURCE_EXHAUSTED in a quota death) serves the
// last-good body with an X-Served-Stale marker instead of a bare
// 500. With no last-good on hand the failure stays a LOUD 500.
function staleOrLoud() {
  const stale = getLastGoodPublic(STALE_KEY);
  if (stale !== undefined) {
    return NextResponse.json(stale, {
      headers: {
        'Cache-Control': PUBLIC_STALE_CACHE_CONTROL,
        'X-Served-Stale': 'last-good',
      },
    });
  }
  return NextResponse.json(
    { error: 'Failed to load governance documents' },
    { status: 500 },
  );
}

function serve(body: unknown) {
  rememberLastGoodPublic(STALE_KEY, body);
  return NextResponse.json(body, {
    headers: { 'Cache-Control': PUBLIC_STALE_CACHE_CONTROL },
  });
}

// GET: public governance documents (spec 4.5). Held behind the
// publication flag (default OFF) until Zubair approves go-live; with
// the flag off the page renders its registration line and empty layers.
export async function GET() {
  try {
    return await getFresh();
  } catch (err) {
    console.error('[governance public] load failed:', err);
    return staleOrLoud();
  }
}

async function getFresh() {
  const db = getDb();
  const empty = {
    layers: { '0': [], '1': [], '2': [] } as Record<
      string,
      PublicRecord[]
    >,
    unlayered: [] as PublicRecord[],
  };
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }
  const registration = await getRegistrationStatus(db as never);
  if (!isGovernancePublicationEnabled()) {
    return serve({ ...empty, registration });
  }

  const snap = await db.collection(GOVERNANCE_COLLECTION).get();
  const all = snap.docs.map((d) =>
    toGovernanceRecord(d.data() as Record<string, unknown>, registration),
  );

  // Current version per family among records that may be public: public
  // tier, approved or effective, and passing the runtime redaction
  // guard re-check (a bad stored state is excluded, never served).
  const byFamily = new Map<string, GovernanceRecord>();
  for (const record of all) {
    if (record.accessLevel !== 'public') continue;
    if (record.status !== 'approved' && record.status !== 'effective') {
      continue;
    }
    if (!isPublishable(record)) {
      console.error(
        `[governance public] record ${record.recordId} is public-tier but blocked by the redaction guard; excluded`,
      );
      continue;
    }
    const current = byFamily.get(record.familyId);
    if (!current || record.version > current.version) {
      byFamily.set(record.familyId, record);
    }
  }

  const layers: Record<string, PublicRecord[]> = { '0': [], '1': [], '2': [] };
  const unlayered: PublicRecord[] = [];
  for (const record of byFamily.values()) {
    if (record.layer === 0 || record.layer === 1 || record.layer === 2) {
      layers[String(record.layer)].push(toPublicRecord(record));
    } else {
      unlayered.push(toPublicRecord(record));
    }
  }
  const byDate = (a: PublicRecord, b: PublicRecord) =>
    b.recordDate.localeCompare(a.recordDate);
  for (const key of Object.keys(layers)) layers[key].sort(byDate);
  unlayered.sort(byDate);

  return serve({ layers, unlayered, registration });
}
