import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { sendRawEmail } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

// E.164 validation: leading + followed by 7-15 digits (country code + subscriber)
const E164_RE = /^\+[1-9]\d{6,14}$/;

// Basic email shape check
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function makeTrackingToken(): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `JOIN-PK-2026-${rand}`;
}

function buildWelcomeHtml(data: {
  fullName: string;
  token: string;
  university: string;
}): string {
  const githubLink = 'https://github.com/seds-pakistan/mars-rover-starter';
  const syllabusLink = 'https://v0-seds-pakistan.vercel.app/downloads/rover-starter-syllabus.pdf';
  return `
  <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #020617; color: #f8fafc; border-radius: 12px; overflow: hidden;">
    <div style="padding: 32px; text-align: center; border-bottom: 1px solid #1e293b;">
      <h1 style="font-size: 22px; margin: 0 0 8px;">SEDS PAKISTAN</h1>
      <p style="color: #94a3b8; margin: 0; font-size: 14px;">Mars Rover Autonomous Navigation Starter</p>
    </div>
    <div style="padding: 32px;">
      <p>Assalam-o-Alaikum ${data.fullName},</p>
      <p>Welcome aboard. Your tracking token is:</p>
      <p style="font-size: 20px; font-weight: 700; color: #10b981; letter-spacing: 0.05em;">${data.token}</p>
      <p>Your instant downloads:</p>
      <ul>
        <li><a href="${githubLink}" style="color: #3b82f6;">Webots Autonomous Mars Rover Navigation Starter Codebase</a></li>
        <li><a href="${syllabusLink}" style="color: #3b82f6;">Rover Starter Syllabus (PDF)</a></li>
      </ul>
      <p>Our team at ${data.university} chapter will reach out within 48 hours with your crucible briefing.</p>
      <p style="color: #94a3b8; font-size: 13px;">Keep this email. Your tracking token is required for all future correspondence.</p>
    </div>
    <div style="padding: 24px 32px; border-top: 1px solid #1e293b; text-align: center; color: #94a3b8; font-size: 12px;">
      SEDS Pakistan | Students for the Exploration and Development of Space
    </div>
  </div>`;
}

function buildWelcomeText(data: { fullName: string; token: string; university: string }): string {
  return `Assalam-o-Alaikum ${data.fullName},

Welcome to SEDS Pakistan. Your tracking token is: ${data.token}

Your instant downloads:
- Webots Autonomous Mars Rover Navigation Starter Codebase: https://github.com/seds-pakistan/mars-rover-starter
- Rover Starter Syllabus (PDF): https://v0-seds-pakistan.vercel.app/downloads/rover-starter-syllabus.pdf

Our team at ${data.university} will reach out within 48 hours with your crucible briefing.

Keep this email. Your tracking token is required for all future correspondence.

SEDS Pakistan`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fullName, email, whatsapp, university, department, graduationYear } = body;

    // Validate required fields
    if (!fullName || !email || !whatsapp || !university || !department || !graduationYear) {
      return NextResponse.json({ error: 'All six fields are required' }, { status: 400 });
    }
    if (!EMAIL_RE.test(String(email).trim())) {
      return NextResponse.json({ error: 'Invalid university email address' }, { status: 400 });
    }
    const whatsappClean = String(whatsapp).replace(/[\s()-]/g, '');
    if (!E164_RE.test(whatsappClean)) {
      return NextResponse.json(
        { error: 'WhatsApp number must be in E.164 format (e.g. +923001234567)' },
        { status: 400 }
      );
    }

    const token = makeTrackingToken();
    const now = new Date().toISOString();

    const leadDoc = {
      fullName: String(fullName).trim(),
      email: String(email).trim().toLowerCase(),
      whatsapp: whatsappClean,
      university: String(university).trim(),
      department: String(department).trim(),
      graduationYear: String(graduationYear).trim(),
      source: 'join_squeeze_page',
      trackingToken: token,
      status: 'pending_crucible',
      createdAt: now,
    };

    // Write to leads and applications via Admin SDK (no public client writes)
    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
    }
    await db.collection('leads').add(leadDoc);
    await db.collection('applications').add({
      ...leadDoc,
      type: 'rover_starter_lead',
      stage: 'pending_crucible',
    });

    // Welcome email (best effort: funnel continues even if email fails)
    let emailSent = false;
    try {
      const res = await sendRawEmail(
        leadDoc.email,
        `Welcome to SEDS Pakistan: Your Rover Starter Pack (${token})`,
        buildWelcomeHtml({ fullName: leadDoc.fullName, token, university: leadDoc.university }),
        buildWelcomeText({ fullName: leadDoc.fullName, token, university: leadDoc.university })
      );
      emailSent = res.success;
      if (!res.success) {
        console.warn('[send-welcome] Email failed:', res.error);
      }
    } catch (mailErr: any) {
      console.warn('[send-welcome] Email exception:', mailErr?.message);
    }

    return NextResponse.json({ success: true, token, emailSent });
  } catch (err: any) {
    console.error('[send-welcome] Handler error:', err?.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
