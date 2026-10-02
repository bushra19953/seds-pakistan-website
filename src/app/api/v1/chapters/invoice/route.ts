import { NextRequest, NextResponse } from 'next/server';
import { jsPDF } from 'jspdf';
import { ensureAdminInitialized, getDb, getAdminStorage } from '@/lib/server/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import type {
  InstitutionalDetails,
  LabBeachhead,
  ChapterOfficer,
  ChapterOfficerRole,
  ChapterInvoiceLineItem,
} from '@/types/chapter';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// AGP invoice configuration.
// NTN, bank name and IBAN are read from env so they can be configured without
// code changes. Fallbacks are clearly marked placeholders: replace with the
// real SEDS Aerospace Private Limited values before issuing live invoices.
// ---------------------------------------------------------------------------
const AGP_CONFIG = {
  payee: 'SEDS Aerospace Private Limited',
  ntn: process.env.SEDS_NTN || '0000000-0',
  bankName: process.env.SEDS_BANK_NAME || 'Bank name (configure SEDS_BANK_NAME)',
  iban: process.env.SEDS_IBAN || 'PK00 0000 0000 0000 0000 0000',
  currency: 'PKR',
  validityDays: 30,
};

const LINE_ITEMS: ChapterInvoiceLineItem[] = [
  {
    description: 'Chapter Charter Registration (one-time institutional onboarding)',
    budgetHead: 'HEC Criterion 6: Institutional Facilities and Infrastructure',
    amount: 25000,
  },
  {
    description: 'Annual Governance Protocol (AGP) Fee',
    budgetHead: 'HEC OBE: Program Governance and Continuous Improvement',
    amount: 15000,
  },
  {
    description: 'OBE-Aligned Student Development Workshops (annual)',
    budgetHead: 'HEC Criterion 6: Student Support and Guidance Services',
    amount: 10000,
  },
];

const OFFICER_ROLES: ChapterOfficerRole[] = [
  'president',
  'vice_president',
  'secretary',
  'treasurer',
  'communications',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface InvoiceRequestBody {
  applicantId?: string;
  applicantName?: string;
  applicantEmail?: string;
  institutional?: InstitutionalDetails;
  officers?: ChapterOfficer[];
  beachhead?: LabBeachhead;
}

function randomToken(length: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function validateBody(body: InvoiceRequestBody): string | null {
  if (!body.applicantId) return 'applicantId is required';
  const inst = body.institutional;
  if (!inst) return 'Institutional details are required';
  if (!inst.universityName?.trim()) return 'University name is required';
  if (!inst.campusCity?.trim()) return 'Campus city is required';
  if (!inst.deanOrFocalName?.trim()) return 'Engineering Dean / ORIC Focal Person name is required';
  if (!inst.deanOrFocalEmail?.trim() || !EMAIL_RE.test(inst.deanOrFocalEmail.trim()))
    return 'A valid Engineering Dean / ORIC Focal Person email is required';
  if (!inst.postalAddress?.trim()) return 'Official postal address is required';

  const officers = body.officers || [];
  if (officers.length !== 5) return 'Exactly 5 founding officers are required';
  const roles = officers.map(o => o.role);
  for (const required of OFFICER_ROLES) {
    if (!roles.includes(required)) return `Missing officer role: ${required}`;
  }
  for (const o of officers) {
    if (!o.name?.trim()) return `Officer name is required (${o.role})`;
    if (!o.email?.trim() || !EMAIL_RE.test(o.email.trim()))
      return `A valid institutional email is required for ${o.role}`;
  }

  if (!body.beachhead || typeof body.beachhead.hasExistingSpaceSociety !== 'boolean')
    return 'Lab and society beachhead details are required';
  return null;
}

function formatPKR(n: number): string {
  return `PKR ${n.toLocaleString('en-PK')}`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-PK', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Build the AGP PDF invoice with jsPDF (no extra plugins, manual table).
// ---------------------------------------------------------------------------
function buildInvoicePdf(args: {
  invoiceNumber: string;
  issuedAt: Date;
  dueDate: Date;
  institutional: InstitutionalDetails;
  lineItems: ChapterInvoiceLineItem[];
  total: number;
}): Buffer {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = 210;
  const margin = 15;
  const contentW = pageW - margin * 2;
  let y = 0;

  const navy: [number, number, number] = [12, 34, 64];
  const gold: [number, number, number] = [184, 134, 11];
  const muted: [number, number, number] = [100, 116, 139];

  // Header band
  doc.setFillColor(...navy);
  doc.rect(0, 0, pageW, 38, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('SEDS PAKISTAN', margin, 14);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(AGP_CONFIG.payee, margin, 21);
  doc.text('National Aerospace Student Society', margin, 26.5);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('OFFICIAL INSTITUTIONAL INVOICE', margin, 34);

  y = 48;

  // Invoice meta
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Invoice No:', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.text(args.invoiceNumber, margin + 30, y);
  doc.setFont('helvetica', 'bold');
  doc.text('Issue Date:', margin + 95, y);
  doc.setFont('helvetica', 'normal');
  doc.text(formatDate(args.issuedAt), margin + 120, y);
  y += 7;
  doc.setFont('helvetica', 'bold');
  doc.text('Valid Until:', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.text(formatDate(args.dueDate), margin + 30, y);
  doc.setFont('helvetica', 'bold');
  doc.text('NTN:', margin + 95, y);
  doc.setFont('helvetica', 'normal');
  doc.text(AGP_CONFIG.ntn, margin + 120, y);
  y += 12;

  // Billed to
  doc.setFillColor(241, 245, 249);
  doc.rect(margin, y - 5, contentW, 34, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Billed To (Institution):', margin + 3, y + 1);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const inst = args.institutional;
  doc.text(inst.universityName, margin + 3, y + 7.5);
  doc.text(`Campus: ${inst.campusCity}`, margin + 3, y + 13);
  doc.text(`Attn: ${inst.deanOrFocalName} (${inst.deanOrFocalEmail})`, margin + 3, y + 18.5);
  const addrLines = doc.splitTextToSize(`Address: ${inst.postalAddress}`, contentW - 6);
  doc.text(addrLines, margin + 3, y + 24);
  y += 34 + (addrLines.length - 1) * 5 + 8;

  // Line items table header
  doc.setFillColor(...navy);
  doc.rect(margin, y - 5, contentW, 9, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('DESCRIPTION', margin + 3, y + 1);
  doc.text('BUDGET HEAD', margin + 92, y + 1);
  doc.text('AMOUNT', margin + contentW - 3, y + 1, { align: 'right' });
  y += 9;

  // Line items rows
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'normal');
  for (const item of args.lineItems) {
    const descLines = doc.splitTextToSize(item.description, 82);
    const headLines = doc.splitTextToSize(item.budgetHead, 62);
    const rowH = Math.max(descLines.length, headLines.length) * 5 + 4;
    if (y + rowH > 265) {
      doc.addPage();
      y = 20;
    }
    doc.setDrawColor(226, 232, 240);
    doc.rect(margin, y - 4, contentW, rowH);
    doc.setFontSize(9);
    doc.text(descLines, margin + 3, y + 1);
    doc.setTextColor(...muted);
    doc.setFontSize(8);
    doc.text(headLines, margin + 92, y + 1);
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(9);
    doc.text(formatPKR(item.amount), margin + contentW - 3, y + 1, { align: 'right' });
    y += rowH + 1;
  }

  // Total
  y += 3;
  doc.setFillColor(240, 253, 244);
  doc.rect(margin, y - 5, contentW, 11, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('TOTAL PAYABLE', margin + 3, y + 2.5);
  doc.text(formatPKR(args.total), margin + contentW - 3, y + 2.5, { align: 'right' });
  y += 14;

  // Payment instructions
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...navy);
  doc.text('PAYMENT INSTRUCTIONS', margin, y);
  y += 7;
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'normal');
  const instructions = [
    `1. Bank wire transfer to: ${AGP_CONFIG.bankName}`,
    `   IBAN: ${AGP_CONFIG.iban}`,
    `   Reference: ${args.invoiceNumber} (quote on all transfers)`,
    `2. Crossed cheque payable to: "${AGP_CONFIG.payee}"`,
    `3. Email the transfer receipt / cheque scan to the SEDS Pakistan secretariat for reconciliation.`,
  ];
  for (const line of instructions) {
    const lines = doc.splitTextToSize(line, contentW);
    if (y + lines.length * 5 > 280) {
      doc.addPage();
      y = 20;
    }
    doc.text(lines, margin, y);
    y += lines.length * 5 + 1;
  }

  y += 4;
  doc.setFontSize(8.5);
  doc.setTextColor(...muted);
  const notes = doc.splitTextToSize(
    'Notes: This invoice is issued under the SEDS Pakistan Annual Governance Protocol (AGP). ' +
      'Budget heads reference HEC Criterion 6 and OBE requirements for university finance processing. ' +
      `This invoice is valid for ${AGP_CONFIG.validityDays} days from the issue date. ` +
      'The chapter charter is activated after payment reconciliation and national board approval.',
    contentW
  );
  if (y + notes.length * 4.5 > 285) {
    doc.addPage();
    y = 20;
  }
  doc.text(notes, margin, y);
  y += notes.length * 4.5 + 8;

  // Footer
  doc.setDrawColor(...gold);
  doc.setLineWidth(0.8);
  doc.line(margin, 287, pageW - margin, 287);
  doc.setFontSize(8);
  doc.setTextColor(...muted);
  doc.text(
    `${AGP_CONFIG.payee} : National Secretariat, SEDS Pakistan : Invoice ${args.invoiceNumber}`,
    pageW / 2,
    292,
    { align: 'center' }
  );

  return Buffer.from(doc.output('arraybuffer'));
}

// ---------------------------------------------------------------------------
// POST /api/v1/chapters/invoice
// Generates the AGP PDF invoice, uploads it to Storage, and records the
// application in chapter_applications with status 'invoice_issued'.
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as InvoiceRequestBody;

    const validationError = validateBody(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const initOk = ensureAdminInitialized();
    const db = getDb();
    if (!initOk || !db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    const applicantId = body.applicantId!;
    const institutional = body.institutional!;
    const officers = body.officers!;
    const beachhead = body.beachhead!;

    // Block blacklisted users (same enforcement as the student flow)
    const [userSnap, configSnap] = await Promise.all([
      db.collection('users').doc(applicantId).get(),
      db.collection('warningConfig').doc('global').get(),
    ]);
    const userData = userSnap.data() || {};
    const configData = configSnap.data() || { enforcementEnabled: true };
    if (configData.enforcementEnabled && userData.isBlacklisted === true) {
      return NextResponse.json(
        { error: 'Action Blocked: Your account is currently blacklisted.' },
        { status: 403 }
      );
    }

    // Prevent duplicate active applications (same guard as student flow, plus invoice_issued)
    const existing = await db
      .collection('chapter_applications')
      .where('applicantId', '==', applicantId)
      .where('status', 'in', [
        'pending_payment',
        'invoice_issued',
        'pending_review',
        'under_review',
        'info_requested',
      ])
      .limit(1)
      .get();
    if (!existing.empty) {
      return NextResponse.json(
        { error: 'You already have an active chapter application. Check your profile for status updates.' },
        { status: 409 }
      );
    }

    const invoiceNumber = `INV-AGP-2026-${randomToken(4)}`;
    const issuedAt = new Date();
    const dueDate = new Date(issuedAt);
    dueDate.setDate(dueDate.getDate() + AGP_CONFIG.validityDays);
    const total = LINE_ITEMS.reduce((sum, i) => sum + i.amount, 0);

    // Build and upload the PDF
    let invoiceUrl = '';
    try {
      const pdfBuffer = buildInvoicePdf({
        invoiceNumber,
        issuedAt,
        dueDate,
        institutional,
        lineItems: LINE_ITEMS,
        total,
      });

      const storageAdmin = getAdminStorage();
      if (storageAdmin) {
        const bucketName =
          process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'seds-pakistan.appspot.com';
        const bucket = storageAdmin.bucket(bucketName);
        const storagePath = `invoices/chapter/${invoiceNumber}.pdf`;
        const fileRef = bucket.file(storagePath);
        await fileRef.save(pdfBuffer, {
          metadata: { contentType: 'application/pdf' },
        });
        try {
          const [readUrl] = await fileRef.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: '03-01-2036',
          });
          invoiceUrl = readUrl;
        } catch {
          invoiceUrl = `https://storage.googleapis.com/${bucketName}/${storagePath}`;
        }
      }
    } catch (pdfErr) {
      console.error('[chapters/invoice] PDF generation/upload failed:', pdfErr);
      return NextResponse.json(
        { error: 'Failed to generate the invoice document. Please try again.' },
        { status: 500 }
      );
    }

    // Record the application with status 'invoice_issued'
    const applicationData = {
      applicantId,
      applicantName: body.applicantName || '',
      applicantEmail: body.applicantEmail || '',
      applicantPhone: '',
      universityName: institutional.universityName.trim(),
      city: institutional.campusCity.trim(),
      country: 'Pakistan',
      proposedChapterName: `SEDS ${institutional.universityName.trim()}`,
      intakeType: 'institutional',
      institutional: {
        universityName: institutional.universityName.trim(),
        campusCity: institutional.campusCity.trim(),
        deanOrFocalName: institutional.deanOrFocalName.trim(),
        deanOrFocalEmail: institutional.deanOrFocalEmail.trim(),
        postalAddress: institutional.postalAddress.trim(),
      },
      teamMembers: officers.map(o => ({
        name: o.name.trim(),
        email: o.email.trim(),
        role: o.role,
        department: '',
      })),
      facultyAdvisor: {
        name: institutional.deanOrFocalName.trim(),
        email: institutional.deanOrFocalEmail.trim(),
        department: '',
        designation: 'Dean / ORIC Focal Person',
      },
      motivation: '',
      existingClubs: beachhead.hasExistingSpaceSociety
        ? beachhead.existingSocietyDetails?.trim() || 'Yes'
        : 'None',
      labFacilities: beachhead.labFacilities?.trim() || '',
      oricEndorsementLetterUrl: beachhead.oricEndorsementLetterUrl || '',
      estimatedMemberCount: 20,
      status: 'invoice_issued',
      invoiceNumber,
      invoiceUrl,
      invoiceIssuedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('chapter_applications').add(applicationData);

    // Audit log
    await db.collection('audit_logs').add({
      action: 'CHAPTER_INVOICE_ISSUED',
      actorUid: applicantId,
      targetUidOrResource: ref.id,
      payload: {
        invoiceNumber,
        universityName: institutional.universityName,
        total,
        currency: AGP_CONFIG.currency,
      },
      timestamp: FieldValue.serverTimestamp(),
      source: 'api',
    });

    return NextResponse.json({
      success: true,
      applicationId: ref.id,
      invoiceNumber,
      invoiceUrl,
      total,
      currency: AGP_CONFIG.currency,
    });
  } catch (e: any) {
    console.error('[chapters/invoice] Handler error:', e);
    return NextResponse.json(
      { error: e?.message || 'Failed to issue invoice' },
      { status: 500 }
    );
  }
}
