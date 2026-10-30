import { NextRequest, NextResponse } from 'next/server'
import { getG4Db, getG4Handle, rehydratePartnerTimestamps } from '@/lib/server/backup-exports/g4-data'
import { supaListAllPartners } from '@/lib/server/crm-supa'
import { verifyAuthentication } from '@/lib/auth-middleware'
import { hasServerPermissionForUser } from '@/lib/server/permissions'
import { writeFinanceAudit } from '@/lib/server/finance-audit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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
  let rawDocs: Array<Record<string, unknown>>
  let servedBySupa: boolean
  if (seamPartners) {
    rawDocs = seamPartners
    servedBySupa = true
  } else {
    const snap = await db.collection('sponsors_partners').get()
    rawDocs = snap.docs.map((doc) => doc.data() as Record<string, unknown>)
    servedBySupa = servedByHandle
  }
  const rows: string[] = []
  const headers = [
    'organizationName','status','relationshipType','sponsorshipTier',
    'primaryContact.name','primaryContact.email','primaryContact.phone','primaryContact.role',
    'financials.pledgedAmount','financials.amountReceived','financials.agreementDate',
    'website','logoUrl','agreementContractUrl','interactionHistory','createdAt','updatedAt',
    // Related-party register columns (spec Part C 4.7, CH-19)
    'isRelatedParty','isFounderCommercialEntity','relatedParty.channel','relatedParty.agreementRef',
    'financials.currency','disclosureRecorded','benchmarkingRecorded'
  ]
  rows.push(headers.join(','))
  for (const rawData of rawDocs) {
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
    const line = vals.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')
    rows.push(line)
  }
  const csv = rows.join('\n')
  // Exports of the register are audit-logged BEFORE the file leaves
  // (spec 4.7): if the audit write fails, the export is not served.
  const batch = db.batch()
  await writeFinanceAudit(db, batch, {
    action: 'PARTNERS_EXPORTED',
    actorUid: auth.user.userId,
    targetUidOrResource: 'sponsors_partners/export',
    payload: { rowCount: rawDocs.length },
  })
  await batch.commit()
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="partners.csv"'
    }
  })
}
