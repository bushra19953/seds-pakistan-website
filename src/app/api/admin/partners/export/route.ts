import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/server/firebase-admin'
import { verifyAuthentication } from '@/lib/auth-middleware'
import { hasServerPermission } from '@/lib/server/permissions'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const auth = await verifyAuthentication(request)
  if (!auth.authenticated || !auth.user) {
    return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 })
  }
  const role = auth.user.role || 'member'
  
  // Use dynamic permission checking
  const canManage = await hasServerPermission(role, 'canManageSponsorsPartners');
  if (!canManage) {
    return NextResponse.json({ error: 'Forbidden: Insufficient permissions to export partners' }, { status: 403 })
  }

  const db = getDb()
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 })
  }
  const snap = await db.collection('sponsors_partners').get()
  const rows: string[] = []
  const headers = [
    'organizationName','status','relationshipType','sponsorshipTier',
    'primaryContact.name','primaryContact.email','primaryContact.phone','primaryContact.role',
    'financials.pledgedAmount','financials.amountReceived','financials.agreementDate',
    'website','logoUrl','agreementContractUrl','interactionHistory','createdAt','updatedAt'
  ]
  rows.push(headers.join(','))
  for (const doc of snap.docs) {
    const d = doc.data() as any
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
      d.updatedAt?.toDate?.()?.toISOString?.() || ''
    ]
    const line = vals.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',')
    rows.push(line)
  }
  const csv = rows.join('\n')
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="partners.csv"'
    }
  })
}
