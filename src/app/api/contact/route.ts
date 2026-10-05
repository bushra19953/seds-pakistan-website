import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ContactSchema = z.object({
  name: z.string().min(2, 'Name is required').max(200),
  email: z.string().email('Valid email required').max(320),
  phone: z.string().max(30).optional().or(z.literal('')),
  message: z.string().min(10, 'Message must be at least 10 characters').max(5000),
});

export async function POST(req: NextRequest) {
  // Initialize Admin per request and acquire Firestore lazily
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ContactSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({
      error: 'Validation failed',
      details: parsed.error.flatten(),
    }, { status: 422 });
  }

  const { name, email, phone, message } = parsed.data;
  const ip = req.headers.get('x-forwarded-for') || (req as any).ip || 'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';

  const bucket = new Date().toISOString().slice(0, 10);
  const rlId = `${ip}:${bucket}`;
  try {
    const rlDoc = db.collection('contactRateLimits').doc(rlId);
    const snap = await rlDoc.get();
    const count = snap.exists ? (snap.data()?.count || 0) : 0;
    if (count >= 10) {
      return NextResponse.json({ error: 'Too many submissions from this IP today' }, { status: 429 });
    }
    await rlDoc.set({ count: admin.firestore.FieldValue.increment(1), lastSubmitAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  } catch (_e) {}

  let savedId: string | null = null;
  try {
    const docRef = await db.collection('contactSubmissions').add({
      name,
      email,
      phone: phone || '',
      message,
      meta: { ip, userAgent },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    savedId = docRef.id;

    // Mirror into the Universal Inbox (`submissions` collection, type CONTACT)
    // so admins actually see contact messages. The inbox reads `submissions`,
    // not `contactSubmissions`.
    try {
      await db.collection('submissions').add({
        type: 'CONTACT',
        status: 'PENDING',
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        user_id: null,
        user_display_name: name,
        user_photo_url: null,
        chapter_id: null,
        summary_text: `Contact: ${name} <${email}>`,
        original_ref: `contactSubmissions/${docRef.id}`,
        contact_name: name,
        contact_email: email,
        contact_phone: phone || '',
        contact_message: message,
      });
    } catch (e: any) {
      console.error('[contact:route] Failed to mirror to submissions inbox', { message: e?.message });
    }
  } catch (e: any) {
    console.error('[contact:route] Failed to save submission', { message: e?.message, stack: e?.stack });
    return NextResponse.json({ error: 'Failed to save submission' }, { status: 500 });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
  const CONTACT_TO_EMAIL_ENV = process.env.CONTACT_TO_EMAIL || '';
  const CONTACT_FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || 'noreply@seds-pakistan.com';

  let destination = CONTACT_TO_EMAIL_ENV;
  try {
    const settingsSnap = await db.collection('settings').doc('siteWide').get();
    const configured = settingsSnap.exists ? (settingsSnap.data() as any)?.contactFormDestinationEmail : '';
    if (configured && String(configured).includes('@')) {
      destination = configured;
    }
  } catch {}

  if (!RESEND_API_KEY || !destination) {
    return NextResponse.json({ ok: true, id: savedId, note: 'Email disabled' }, { status: 200 });
  }

  try {
    const subject = `New Contact Message from ${name}`;
    const text = `Name: ${name}\nEmail: ${email}\nPhone: ${phone || 'not provided'}\n\nMessage:\n${message}\n\nIP: ${ip}\nUser-Agent: ${userAgent}\nSubmission ID: ${savedId}`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: CONTACT_FROM_EMAIL, to: destination, subject, text }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[contact:route] Email send failed', err);
      return NextResponse.json({ ok: false, id: savedId, error: 'Email send failed' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, id: savedId }, { status: 200 });
  } catch (e: any) {
    console.error('[contact:route] Email send error', { message: e?.message });
    return NextResponse.json({ ok: false, id: savedId, error: 'Email send error' }, { status: 502 });
  }
}
