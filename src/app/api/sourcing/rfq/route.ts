import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifySession, SessionError } from '@/lib/auth/verifySession';
import { sendRawEmail } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

export const MANUFACTURING_CATEGORIES = [
  '5-Axis High-Speed CNC Machining (Sendottech / Dongguan)',
  'Multilayer SMT PCBA & Avionics (ILINKGLOBE / Shenzhen)',
  'SLM Metal Additive Manufacturing Inconel/Titanium (Yunzhu 3D / Shanghai)',
  'Precision Molds & Aerospace Composites (Taizhou Tengfei)',
] as const;

const MAX_CAD_BYTES = 100 * 1024 * 1024;

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

interface CadFileMeta {
  fileName: string;
  storagePath: string;
  sizeBytes: number;
  contentType: string;
  downloadUrl: string;
}

/** Generate a unique RFQ tracking token in the form RFQ-PK-2026-XXXX. */
async function generateTrackingToken(db: FirebaseFirestore.Firestore): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = String(Math.floor(1000 + Math.random() * 9000));
    const token = `RFQ-PK-2026-${suffix}`;
    const existing = await db.collection('sourcing_rfqs').where('trackingToken', '==', token).limit(1).get();
    if (existing.empty) return token;
  }
  return `RFQ-PK-2026-${Date.now().toString().slice(-4)}`;
}

export async function POST(req: NextRequest) {
  let decoded;
  try {
    decoded = await verifySession(req);
  } catch (err) {
    if (err instanceof SessionError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    projectTitle,
    organizationName,
    contactPerson,
    whatsapp,
    category,
    materialSpec,
    targetTolerance,
    inquiryId,
    cadFiles,
    notes,
  } = body ?? {};

  // Field validation
  if (!projectTitle || typeof projectTitle !== 'string' || !projectTitle.trim()) {
    return NextResponse.json({ error: 'Project Title is required' }, { status: 400 });
  }
  if (!organizationName || typeof organizationName !== 'string' || !organizationName.trim()) {
    return NextResponse.json({ error: 'Organization Name is required' }, { status: 400 });
  }
  if (!contactPerson || typeof contactPerson !== 'string' || !contactPerson.trim()) {
    return NextResponse.json({ error: 'Contact Person is required' }, { status: 400 });
  }
  if (!whatsapp || typeof whatsapp !== 'string' || !E164_REGEX.test(whatsapp.trim())) {
    return NextResponse.json(
      { error: 'WhatsApp Number must be in E.164 format (e.g. +923001234567)' },
      { status: 400 },
    );
  }
  if (!category || !(MANUFACTURING_CATEGORIES as readonly string[]).includes(category)) {
    return NextResponse.json({ error: 'A valid Manufacturing Category is required' }, { status: 400 });
  }
  if (!materialSpec || typeof materialSpec !== 'string' || !materialSpec.trim()) {
    return NextResponse.json({ error: 'Material Specification is required (e.g. Al 7075-T6, Inconel 718, FR-4)' }, { status: 400 });
  }
  if (!targetTolerance || typeof targetTolerance !== 'string' || !targetTolerance.trim()) {
    return NextResponse.json({ error: 'Target Tolerance is required (e.g. +/- 0.005mm)' }, { status: 400 });
  }
  if (!inquiryId || typeof inquiryId !== 'string' || !inquiryId.trim()) {
    return NextResponse.json({ error: 'Inquiry ID is required' }, { status: 400 });
  }
  if (!Array.isArray(cadFiles) || cadFiles.length === 0) {
    return NextResponse.json({ error: 'At least one CAD package must be uploaded to the vault' }, { status: 400 });
  }
  for (const f of cadFiles as CadFileMeta[]) {
    if (!f?.storagePath || !f?.fileName || typeof f?.sizeBytes !== 'number') {
      return NextResponse.json({ error: 'CAD file metadata is incomplete' }, { status: 400 });
    }
    if (f.sizeBytes > MAX_CAD_BYTES) {
      return NextResponse.json({ error: `CAD file ${f.fileName} exceeds the 100MB vault limit` }, { status: 400 });
    }
    if (!String(f.storagePath).startsWith('cad-vault/')) {
      return NextResponse.json({ error: `CAD file ${f.fileName} is not inside the cad-vault` }, { status: 400 });
    }
  }

  ensureAdminInitialized();
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Server misconfiguration: Firestore unavailable' }, { status: 500 });
  }

  const trackingToken = await generateTrackingToken(db);

  const record = {
    projectTitle: projectTitle.trim(),
    organizationName: organizationName.trim(),
    contactPerson: contactPerson.trim(),
    whatsapp: whatsapp.trim(),
    category,
    materialSpec: materialSpec.trim(),
    targetTolerance: targetTolerance.trim(),
    inquiryId: inquiryId.trim(),
    cadFiles: (cadFiles as CadFileMeta[]).map((f) => ({
      fileName: f.fileName,
      storagePath: f.storagePath,
      sizeBytes: f.sizeBytes,
      contentType: f.contentType || '',
      downloadUrl: f.downloadUrl || '',
    })),
    notes: typeof notes === 'string' ? notes.trim() : '',
    trackingToken,
    submittedByUid: decoded.uid,
    submittedByEmail: decoded.email || '',
    status: 'rfq_received', // rfq_received | under_review | quote_issued | in_production | fulfilled
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const docRef = await db.collection('sourcing_rfqs').add(record);

  // Confirmation email (best effort; must not fail the RFQ)
  if (decoded.email) {
    try {
      await sendRawEmail(
        decoded.email,
        `[SEDS Sourcing Bridge] RFQ Received - ${trackingToken}`,
        `<div style="font-family: Arial, sans-serif; background-color: #0B0F19; color: #ffffff; padding: 30px; border-radius: 12px;">
          <h1 style="color: #60A5FA; font-size: 22px;">SEDS Sourcing Bridge</h1>
          <p style="color: #E5E7EB; font-size: 14px; line-height: 1.6;">
            Hello <strong>${contactPerson.trim()}</strong>,<br><br>
            Your manufacturing RFQ for <strong>${projectTitle.trim()}</strong> has been received and logged.
            Our Shanghai liaison team will review your CAD package and respond with factory-direct pricing.
          </p>
          <p style="color: #9CA3AF; font-size: 13px;">Tracking token: <strong style="color: #34D399;">${trackingToken}</strong></p>
          <p style="color: #9CA3AF; font-size: 13px;">Category: ${category}</p>
          <p style="color: #9CA3AF; font-size: 13px;">CAD files: ${(cadFiles as CadFileMeta[]).length}</p>
        </div>`,
      );
    } catch (emailErr) {
      console.warn('RFQ confirmation email failed:', emailErr);
    }
  }

  return NextResponse.json(
    {
      success: true,
      trackingToken,
      recordId: docRef.id,
    },
    { status: 201 },
  );
}
