import { NextRequest, NextResponse } from 'next/server'
import { getG4Db, getG4Handle, rehydratePartnerTimestamps } from '@/lib/server/backup-exports/g4-data'
import { supaListAllPartners } from '@/lib/server/crm-supa'
import { verifyAuthentication } from '@/lib/auth-middleware'
import { hasServerPermissionForUser } from '@/lib/server/permissions'
import { writeFinanceAudit } from '@/lib/server/finance-audit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Heap guard (fix/partners-export-streaming-v2): the route built the full
// CSV string in memory (rows array + one joined string) before serving.
// It now streams lines out, so retained memory past the input docs is one
// line at a time. The input shape is deliberately UNCHANGED from the
// pinned seam contracts: the fallback is exactly one
// db.collection('sponsors_partners').get() (no orderBy/limit/startAfter
// chaining, no new imports), so the fallback snapshot is still fully
// materialized — the v1 paging idea is withdrawn because the G4 handle
// contract does not allow query chaining. Audit-before-serve is
// preserved: rowCount is known from the snapshot before the audit runs,
// and no bytes are served before the audit commits.
const EXPORT_HEADERS = [
  'organizationName','status','relationshipType','sponsorshipTier',
  'primaryContact.name','primaryContact.email','primaryContact.phone','primaryContact.role',
  'financials.pledgedAmount','financials.amountReceived','financials.agreementDate',
  'website','logoUrl','agreementContractUrl','interactionHistory','createdAt','updatedAt',
  // Related-party register columns (spec Part C 4.7, CH-19)
  'isRelatedParty','isFounderCommercialEntity','relatedParty.channel','relatedParty.agreementRef',
  'financials.currency','disclosureRecorded','benchmarkingRecorded'
];

function partnerLine(rawData: Record<string, unknown>, servedBySupa: boolean): string {
  const d = (servedBySupa ? rehydratePartnerTimestamps(rawData) : rawData) as any
  const interactions = Array.isArray(d.interactionHistory)
    ? d.interactionHistory.map((it: any) => {
        const t = it.timestamp?.toDate?.()?.toISOString?.() || ''
        const a = it.author || ''
        const n = (it.note || '').replace(/\r?\n/g, ' ').replace(/"/g, '\\"')
        return `${t} ${a}: ${n}`
      }).join(' | ')
    : typeof d.interactionHistory === 'string' ? d.interactionHistory : ''
  const vals = [
    d.organizationName || '',
    d.status || '',
    d.relationshipType || '',
    d.sponsorshipTier || '',
    d.primaryContact?.name || '',
    d.primaryContact?.email || '',
    d.primaryContact?.phone || '',
    d.primaryContact?.role || '',
    String(d.financials?.pledgedAmount ?? ''),
    String(d.financials?.amountReceived ?? ''),
    d.financials?.agreementDate || '',
    d.website || '',
    d.logoUrl || '',
    d.agreementContractUrl || '',
    interactions || '',
    d.createdAt?.toDate?.()?.toISOString?.() || '',
    d.updatedAt?.toDate?.()?.toISOString?.() || '',
    String(d.isRelatedParty === true),
    String(d.isFounderCommercialEntity === true),
    d.relatedParty?.channel != null ? String(d.relatedParty.channel) : '',
    d.relatedParty?.agreementRef || '',
    d.financials?.currency || 'PKR',
    String(d.relatedParty?.disclosureRecorded === true),
    String(d.relatedParty?.benchmarkingRecorded === true)
  ]
  return vals.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')
}

function csvStream(documents: AsyncIterable<Record<string, unknown>>, servedBySupa: boolean): ReadableStream {
  const encoder = new TextEncoder()
  const iterator = documents[Symbol.asyncIterator]()
  let headerSent = false
  return new ReadableStream({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true
        controller.enqueue(encoder.encode(EXPORT_HEADERS.join(',')))
        return
      }
      const next = await iterator.next()
      if (next.done) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode('\n' + partnerLine(next.value, servedBySupa)))
    },
    cancel() {
      void iterator.return?.()
    },
  })
}

async function* arrayDocuments(docs: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const d of docs) yield d
}

export async function GET(request: NextRequest) {
  const auth = await verifyAuthentication(request)
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 })
  }
  // Use dynamic permission checking
  const canManage = await hasServerPermissionForUser(getG4Db() as never, auth.user.userId, 'canManageSponsorsPartners');
  if (!canManage) {
    return NextResponse.json({ error: 'Forbidden: Insufficient permissions to export partners' }, { status: 403 })
  }

  const db = getG4Db()
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 })
  }
  // When a Supabase read served the data, adapter-written timestamps
  // arrive as ISO strings and the .toDate?.() cells below would silently
  // blank; rehydrate exactly the rendered timestamp fields back to
  // Timestamp-like objects so the CSV matches the Firestore output
  // (PLAN_G4 section 3). Flag-off reads skip this entirely.
  const servedByHandle = getG4Handle() !== null
  // READ-BLEED FIX (train 2): the partners read goes through the CRM
  // seam first (supaListAllPartners — the same helper the CRM pages'
  // list route serves; adapter keyset-paged, complete, zero Firestore
  // reads). Only when the seam cannot serve (surface off /
  // unconfigured / adapter error => null) does the previous path run:
  // an unbounded full-collection get on the G4 db (the
  // 'backup-exports' handle when it serves, else Firestore). Export
  // content is identical on both paths; permission gate and the
  // audit-before-serve write below stay on the G4 db untouched.
  const seamPartners = await supaListAllPartners()
  let servedBySupa: boolean
  let rowCount: number
  let stream: ReadableStream
  if (seamPartners) {
    servedBySupa = true
    rowCount = seamPartners.length
    stream = csvStream(arrayDocuments(seamPartners), servedBySupa)
  } else {
    servedBySupa = servedByHandle
    // Contract shape, unchanged from the previous implementation: exactly
    // one collection .get() (no query chaining). The snapshot is fully
    // materialized here, as before; only the output is streamed.
    const snap = await db.collection('sponsors_partners').get()
    const rawDocs = snap.docs.map((doc) => doc.data() as Record<string, unknown>)
    rowCount = rawDocs.length
    stream = csvStream(arrayDocuments(rawDocs), servedBySupa)
  }
  // Exports of the register are audit-logged BEFORE the file leaves
  // (spec 4.7): if the audit write fails, the export is not served.
  const batch = db.batch()
  await writeFinanceAudit(db, batch, {
    action: 'PARTNERS_EXPORTED',
    actorUid: auth.user.userId,
    targetUidOrResource: 'sponsors_partners/export',
    payload: { rowCount },
  })
  await batch.commit()
  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="partners.csv"'
    }
  })
}
