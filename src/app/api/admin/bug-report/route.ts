import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';

export const dynamic = 'force-dynamic';

/**
 * POST: Submit a bug report / suggestion.
 * Any authenticated admin user can submit.
 * The report is:
 *   1. Stored in Firestore `bug_reports` collection
 *   2. Emailed to the configured bugReportEmail (from site settings)
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAuthentication(request);
    if (!auth.authenticated || !auth.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    ensureAdminInitialized();
    const db = getDb();
    if (!db) throw new Error('DB connection failed');

    const body = await request.json();
    const { type, subject, description, page, screenshotUrl } = body;

    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      return NextResponse.json({ error: 'Subject is required' }, { status: 400 });
    }
    if (!description || typeof description !== 'string' || !description.trim()) {
      return NextResponse.json({ error: 'Description is required' }, { status: 400 });
    }

    const reportType = type === 'suggestion' ? 'suggestion' : 'bug';
    const userObj = auth.user as any;

    // Store in Firestore
    const reportData = {
      type: reportType,
      subject: subject.trim(),
      description: description.trim(),
      page: page || '',
      screenshotUrl: screenshotUrl || null,
      submittedBy: userObj.email || 'unknown',
      submittedByUid: userObj.userId || userObj.uid || '',
      submittedByRole: userObj.role || '',
      status: 'open',
      createdAt: new Date(),
    };

    const docRef = await db.collection('bug_reports').add(reportData);

    // Try to send email notification
    let emailSent = false;
    try {
      // Get the configured bug report email from site settings
      const settingsDoc = await db.collection('settings').doc('siteWide').get();
      const bugReportEmail = settingsDoc.data()?.bugReportEmail;

      if (bugReportEmail && process.env.RESEND_API_KEY) {
        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://seds.pk';
        const fromEmail = process.env.EMAIL_FROM || 'SEDS Admin <onboarding@resend.dev>';

        const typeLabel = reportType === 'suggestion' ? 'Suggestion' : 'Bug Report';
        const typeColor = reportType === 'suggestion' ? '#3b82f6' : '#ef4444';

        const html = `
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 20px;">
            <div style="max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 32px; border: 1px solid #334155;">
              <h2 style="color: ${typeColor}; margin: 0 0 16px;">New ${typeLabel}</h2>
              <div style="background: #0f172a; border-left: 4px solid ${typeColor}; padding: 16px; border-radius: 0 8px 8px 0; margin: 16px 0;">
                <h3 style="margin: 0 0 8px; color: #fff;">${subject.trim()}</h3>
                <p style="margin: 0; color: #94a3b8; white-space: pre-wrap;">${description.trim()}</p>
              </div>
              <table style="width: 100%; margin: 16px 0; color: #94a3b8; font-size: 14px;">
                <tr><td style="padding: 4px 0;"><strong>From:</strong></td><td>${userObj.email || 'Unknown'}</td></tr>
                <tr><td style="padding: 4px 0;"><strong>Role:</strong></td><td>${userObj.role || 'N/A'}</td></tr>
                <tr><td style="padding: 4px 0;"><strong>Page:</strong></td><td>${page || 'N/A'}</td></tr>
                ${screenshotUrl ? `<tr><td style="padding: 4px 0;"><strong>Screenshot:</strong></td><td><a href="${screenshotUrl}" style="color: #3b82f6;">View Screenshot</a></td></tr>` : ''}
              </table>
              ${screenshotUrl ? `
              <div style="margin: 16px 0; border-radius: 8px; overflow: hidden; border: 1px solid #334155;">
                <img src="${screenshotUrl}" alt="Bug Screenshot" style="width: 100%; display: block;">
              </div>
              ` : ''}
              <hr style="border: none; border-top: 1px solid #334155; margin: 24px 0;">
              <p style="color: #64748b; font-size: 12px; margin: 0;">
                Submitted via SEDS Admin Bug Report system.
              </p>
            </div>
          </body>
          </html>
        `;

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [bugReportEmail],
            subject: `[${typeLabel}] ${subject.trim()}`,
            html,
            text: `${typeLabel}: ${subject.trim()}\n\n${description.trim()}\n\nFrom: ${userObj.email}\nRole: ${userObj.role}\nPage: ${page}`,
          }),
        });

        emailSent = res.ok;
        if (!res.ok) {
          console.warn('[bug-report] Email send failed:', res.status);
        }
      }
    } catch (emailErr) {
      console.warn('[bug-report] Email notification failed:', emailErr);
    }

    return NextResponse.json({
      success: true,
      id: docRef.id,
      emailSent,
    });
  } catch (error) {
    console.error('[bug-report] POST error:', error);
    return NextResponse.json({ error: 'Failed to submit report' }, { status: 500 });
  }
}
