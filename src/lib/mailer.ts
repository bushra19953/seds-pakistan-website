import nodemailer from 'nodemailer';

const RESEND_API_KEYS = [
    process.env.RESEND_API_KEY,
].filter(Boolean) as string[];

let activeKeyIndex = 0;
// Credentials are loaded from environment variables. See .env.example.
// Never hardcode secrets in source: they belong in .env.local (gitignored).
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD || '';
const FROM_EMAIL = `"SEDS Pakistan" <${GMAIL_USER}>`;
const RESEND_FROM = 'SEDS Pakistan <onboarding@resend.dev>';

/**
 * Creates fresh SMTP Transporter per request on Vercel Serverless
 * to avoid stale/frozen socket connection errors.
 */
function createSmtpTransporter() {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: GMAIL_USER,
            pass: GMAIL_PASS,
        },
    });
}

const CANONICAL_DOMAIN = 'https://seds-pakistan.vercel.app';
let BASE_URL = CANONICAL_DOMAIN;

if (process.env.NEXT_PUBLIC_BASE_URL) {
    BASE_URL = process.env.NEXT_PUBLIC_BASE_URL.startsWith('http') 
      ? process.env.NEXT_PUBLIC_BASE_URL 
      : `https://${process.env.NEXT_PUBLIC_BASE_URL}`;
} else if (process.env.NODE_ENV === 'development') {
    BASE_URL = 'http://localhost:3000';
} else {
    BASE_URL = CANONICAL_DOMAIN;
}

// Rate limiting
let emailsSentToday = 0;
let lastResetDate = new Date().toDateString();
const DAILY_LIMIT = parseInt(process.env.EMAIL_DAILY_LIMIT || '1000'); 

function checkRateLimit(): boolean {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
        emailsSentToday = 0;
        lastResetDate = today;
    }
    return emailsSentToday < DAILY_LIMIT;
}

/**
 * Email template types
 */
export type EmailTemplate =
    | 'task_assigned'
    | 'task_status_change'
    | 'task_submitted_for_review'
    | 'task_approved'
    | 'task_feedback';

/**
 * Generate HTML email content with SEDS "Mission Command" aesthetic
 */
export function generateEmailHtml(
    template: EmailTemplate,
    data: {
        recipientName: string;
        taskTitle: string;
        taskLink: string;
        actorName?: string;
        statusFrom?: string;
        statusTo?: string;
        feedbackText?: string;
        dueDate?: string;
    }
): { subject: string; html: string; text: string } {
    const fullLink = data.taskLink.startsWith('http') ? data.taskLink : `${BASE_URL}${data.taskLink}`;
    const logoUrl = 'https://seds-pakistan.vercel.app/assets/logo.png';

    const colors = {
        bg: '#020617',
        card: '#0f172a',
        border: '#1e293b',
        primary: '#10b981',
        secondary: '#3b82f6',
        accent: '#8b5cf6',
        text: '#f8fafc',
        muted: '#94a3b8',
        amber: '#f59e0b',
    };

    const styles = {
        container: `background-color: ${colors.bg}; padding: 40px 20px; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;`,
        card: `background-color: ${colors.card}; border: 1px solid ${colors.border}; border-radius: 12px; max-width: 600px; margin: 0 auto; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);`,
        header: `padding: 32px 32px 24px; text-align: center; border-bottom: 1px solid ${colors.border}; background: radial-gradient(circle at top, #1e1b4b 0%, ${colors.card} 100%);`,
        body: `padding: 32px; color: ${colors.text};`,
        footer: `padding: 24px 32px; background-color: rgba(2, 6, 23, 0.5); border-top: 1px solid ${colors.border}; text-align: center;`,
        h1: `font-size: 20px; font-weight: 700; margin: 0 0 8px; letter-spacing: -0.025em; text-transform: uppercase;`,
        button: `display: inline-block; background-color: ${colors.primary}; color: #020617; font-weight: 700; font-size: 14px; text-decoration: none; padding: 12px 28px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 24px; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4);`,
        badge: `display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;`,
        metaBox: `background-color: rgba(30, 41, 59, 0.5); border: 1px solid ${colors.border}; border-radius: 8px; padding: 16px; margin: 20px 0;`,
        metaRow: `display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px;`,
        metaLabel: `color: ${colors.muted}; font-weight: 500;`,
        metaValue: `color: ${colors.text}; font-weight: 600; text-align: right;`,
        footerText: `color: ${colors.muted}; font-size: 12px; margin: 0; line-height: 1.5;`,
    };

    let subject = '';
    let headerTitle = '';
    let bodyContent = '';
    let accentColor = colors.primary;
    let text = '';

    switch (template) {
        case 'task_assigned':
            subject = `🚀 Mission Assignment: ${data.taskTitle}`;
            headerTitle = 'New Directive Assigned';
            accentColor = colors.primary;
            bodyContent = `
                <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">Cadet <strong>${data.recipientName}</strong>,</p>
                <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: ${colors.muted};">You have been designated as the primary operative for a new mission directive.</p>
                <div style="${styles.metaBox}">
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Directive:</span>
                        <span style="${styles.metaValue}">${data.taskTitle}</span>
                    </div>
                    ${data.actorName ? `
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Assigned By:</span>
                        <span style="${styles.metaValue}">${data.actorName}</span>
                    </div>` : ''}
                    ${data.dueDate ? `
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Target Deadline:</span>
                        <span style="${styles.metaValue}; color: ${colors.amber};">${data.dueDate}</span>
                    </div>` : ''}
                </div>
                <div style="text-align: center;">
                    <a href="${fullLink}" style="${styles.button}">Acknowledge &amp; View Mission</a>
                </div>
            `;
            text = `Mission Assignment: ${data.taskTitle}\nAssigned by: ${data.actorName || 'Command'}\n\nView details: ${fullLink}`;
            break;

        case 'task_status_change':
            subject = `⚡ Status Update: ${data.taskTitle} → ${data.statusTo}`;
            headerTitle = 'Directive Status Altered';
            accentColor = colors.secondary;
            bodyContent = `
                <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">Operative <strong>${data.recipientName}</strong>,</p>
                <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: ${colors.muted};">The operational status of your directive has transitioned.</p>
                <div style="${styles.metaBox}">
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Directive:</span>
                        <span style="${styles.metaValue}">${data.taskTitle}</span>
                    </div>
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Transition:</span>
                        <span style="${styles.metaValue}">
                            <span style="color: ${colors.muted}; text-decoration: line-through;">${data.statusFrom || 'Unknown'}</span>
                            &nbsp;➔&nbsp;
                            <span style="color: ${colors.secondary};">${data.statusTo}</span>
                        </span>
                    </div>
                </div>
                <div style="text-align: center;">
                    <a href="${fullLink}" style="${styles.button}; background-color: ${colors.secondary};">Inspect Directive</a>
                </div>
            `;
            text = `Status Update: ${data.taskTitle}\nStatus: ${data.statusFrom} -> ${data.statusTo}\n\nView: ${fullLink}`;
            break;

        case 'task_submitted_for_review':
            subject = `🛡️ Directive Review Requested: ${data.taskTitle}`;
            headerTitle = 'Quality Assurance Review';
            accentColor = colors.accent;
            bodyContent = `
                <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">Commander <strong>${data.recipientName}</strong>,</p>
                <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: ${colors.muted};">An operative has completed operational milestones and requested verification.</p>
                <div style="${styles.metaBox}">
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Directive:</span>
                        <span style="${styles.metaValue}">${data.taskTitle}</span>
                    </div>
                    ${data.actorName ? `
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Submitted By:</span>
                        <span style="${styles.metaValue}">${data.actorName}</span>
                    </div>` : ''}
                </div>
                <div style="text-align: center;">
                    <a href="${fullLink}" style="${styles.button}; background-color: ${colors.accent};">Commence Review</a>
                </div>
            `;
            text = `Review Requested: ${data.taskTitle}\nSubmitted by: ${data.actorName}\n\nReview now: ${fullLink}`;
            break;

        case 'task_approved':
            subject = `🏆 Directive Approved &amp; XP Granted: ${data.taskTitle}`;
            headerTitle = 'Mission Accomplished';
            accentColor = colors.primary;
            bodyContent = `
                <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">Cadet <strong>${data.recipientName}</strong>,</p>
                <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: ${colors.muted};">Your directive submission has met flight standards and been approved by Command.</p>
                <div style="${styles.metaBox}">
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Directive:</span>
                        <span style="${styles.metaValue}">${data.taskTitle}</span>
                    </div>
                    ${data.actorName ? `
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Verified By:</span>
                        <span style="${styles.metaValue}">${data.actorName}</span>
                    </div>` : ''}
                </div>
                <div style="text-align: center;">
                    <a href="${fullLink}" style="${styles.button}">View Recognition &amp; Log</a>
                </div>
            `;
            text = `Directive Approved: ${data.taskTitle}\nVerified by: ${data.actorName}\n\nView: ${fullLink}`;
            break;

        case 'task_feedback':
            subject = `⚠️ Action Required: Feedback on ${data.taskTitle}`;
            headerTitle = 'Directive Feedback';
            accentColor = colors.amber;
            bodyContent = `
                <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">Operative <strong>${data.recipientName}</strong>,</p>
                <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: ${colors.muted};">Command has provided corrective feedback regarding your submission.</p>
                <div style="${styles.metaBox}">
                    <div style="${styles.metaRow}">
                        <span style="${styles.metaLabel}">Directive:</span>
                        <span style="${styles.metaValue}">${data.taskTitle}</span>
                    </div>
                    ${data.feedbackText ? `
                    <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid ${colors.border}; font-size: 13px; color: #e2e8f0; font-style: italic;">
                        &ldquo;${data.feedbackText}&rdquo;
                    </div>` : ''}
                </div>
                <div style="text-align: center;">
                    <a href="${fullLink}" style="${styles.button}; background-color: ${colors.amber};">Review &amp; Revise</a>
                </div>
            `;
            text = `Feedback on: ${data.taskTitle}\nNotes: ${data.feedbackText}\n\nView: ${fullLink}`;
            break;

        default:
            subject = `SEDS Mission Command: ${data.taskTitle}`;
            headerTitle = 'Mission Communication';
            bodyContent = `
                <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6;">Hello <strong>${data.recipientName}</strong>,</p>
                <p style="margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: ${colors.muted};">You have an update regarding <strong>${data.taskTitle}</strong>.</p>
                <div style="text-align: center;">
                    <a href="${fullLink}" style="${styles.button}">Access Terminal</a>
                </div>
            `;
            text = `Mission Update: ${data.taskTitle}\n\nView log: ${fullLink}`;
    }

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${subject}</title>
    </head>
    <body style="margin: 0; padding: 0; ${styles.container}">
        <div style="${styles.card}">
            <div style="${styles.header}">
                <img src="${logoUrl}" alt="SEDS Logo" width="180" style="height: auto; margin-bottom: 24px;">
                <h1 style="${styles.h1} color: ${accentColor};">${headerTitle}</h1>
            </div>
            <div style="${styles.body}">
                ${bodyContent}
            </div>
            <div style="${styles.footer}">
                <p style="${styles.footerText}">SEDS Pakistan Command &amp; Control Terminal</p>
                <p style="${styles.footerText}; margin-top: 4px; color: #334155;">Security Level: encrypted-channel-09</p>
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid ${colors.border};">
                    <a href="${BASE_URL}" style="color: ${colors.primary}; text-decoration: none; font-size: 10px; font-weight: bold; margin: 0 8px;">PORTAL</a>
                    <a href="${BASE_URL}/privacy" style="color: #475569; text-decoration: none; font-size: 10px; margin: 0 8px;">PRIVACY</a>
                    <a href="mailto:support@seds.pk" style="color: #475569; text-decoration: none; font-size: 10px; margin: 0 8px;">SUPPORT</a>
                </div>
            </div>
        </div>
        <p style="text-align: center; color: #334155; font-size: 10px; margin-top: 24px; font-family: monospace;">
            AUTOGENERATED BY SEDS-CORE-v2.0 // NO REPLY REQUIRED
        </p>
    </body>
    </html>
  `;

    return { subject, html, text };
}

/**
 * Send an email notification via SMTP Transporter / Resend API
 */
export async function sendEmailNotification(
    to: string,
    template: EmailTemplate,
    data: Parameters<typeof generateEmailHtml>[1]
): Promise<{ success: boolean; error?: string }> {
    const { subject, html, text } = generateEmailHtml(template, data);
    let result: { success: boolean; error?: string } = { success: false };

    // 1. Direct Dedicated SMTP Transporter
    try {
        const transporter = createSmtpTransporter();
        await transporter.sendMail({
            from: FROM_EMAIL,
            to,
            subject,
            html,
            text,
        });
        emailsSentToday++;
        console.log(`[mailer] Sent ${template} via SMTP to ${to}`);
        result = { success: true };
        await logEmailAttempt(to, template, subject, html, result);
        return result;
    } catch (smtpErr: any) {
        console.warn('[mailer] SMTP dispatch exception, trying Resend pool:', smtpErr.message);
    }

    // 2. Resend Key Rotation Fallback
    try {
        if (RESEND_API_KEYS.length === 0) {
            result = { success: false, error: 'Email not configured' };
            await logEmailAttempt(to, template, subject, html, result);
            return result;
        }

        let attempts = 0;
        const maxAttempts = RESEND_API_KEYS.length;

        while (attempts < maxAttempts) {
            const currentKey = RESEND_API_KEYS[activeKeyIndex];
            
            try {
                const res = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${currentKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: RESEND_FROM,
                        to: [to],
                        subject,
                        html,
                        text,
                    }),
                });

                if (res.ok) {
                    emailsSentToday++;
                    console.log(`[mailer] Sent ${template} to ${to} (Key Index: ${activeKeyIndex})`);
                    result = { success: true };
                    await logEmailAttempt(to, template, subject, html, result);
                    return result;
                }

                const err = await res.json().catch(() => ({}));
                result = { success: false, error: err.message || `HTTP ${res.status}` };
            } catch (err: any) {
                result = { success: false, error: err.message };
            }

            activeKeyIndex = (activeKeyIndex + 1) % maxAttempts;
            attempts++;
        }

        await logEmailAttempt(to, template, subject, html, result);
        return result;
    } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        await logEmailAttempt(to, template, subject, html, result).catch(() => {});
        return result;
    }
}

/**
 * Send custom raw HTML/text email using SMTP Transporter with Resend fallback
 */
export async function sendRawEmail(
    to: string,
    subject: string,
    html: string,
    text?: string
): Promise<{ success: boolean; error?: string }> {
    let result: { success: boolean; error?: string } = { success: false };

    // 1. Direct Dedicated SMTP Transporter (Guaranteed Universal Delivery)
    try {
        const transporter = createSmtpTransporter();
        const info = await transporter.sendMail({
            from: FROM_EMAIL,
            to,
            subject,
            html,
            text: text || '',
        });
        emailsSentToday++;
        console.log(`[mailer] Sent raw email via SMTP to ${to} (MessageId: ${info.messageId})`);
        result = { success: true };
        await logEmailAttempt(to, 'sourcing_bridge', subject, html, result);
        return result;
    } catch (smtpErr: any) {
        console.warn('[mailer] SMTP dispatch exception in sendRawEmail, falling back to Resend:', smtpErr.message);
    }

    // 2. Resend Key Pool Fallback
    try {
        if (RESEND_API_KEYS.length === 0) {
            result = { success: false, error: 'Email delivery credentials unconfigured' };
            await logEmailAttempt(to, 'sourcing_custom', subject, html, result);
            return result;
        }

        let attempts = 0;
        const maxAttempts = RESEND_API_KEYS.length;

        while (attempts < maxAttempts) {
            const currentKey = RESEND_API_KEYS[activeKeyIndex];
            
            try {
                const res = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${currentKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: RESEND_FROM,
                        to: [to],
                        subject,
                        html,
                        text: text || '',
                    }),
                });

                if (res.ok) {
                    emailsSentToday++;
                    console.log(`[mailer] Sent raw email via Resend to ${to} (Key Index: ${activeKeyIndex})`);
                    result = { success: true };
                    await logEmailAttempt(to, 'sourcing_bridge', subject, html, result);
                    return result;
                }

                const err = await res.json().catch(() => ({}));
                result = { success: false, error: err.message || `HTTP ${res.status}` };
            } catch (err: any) {
                result = { success: false, error: err.message };
            }

            activeKeyIndex = (activeKeyIndex + 1) % maxAttempts;
            attempts++;
        }

        await logEmailAttempt(to, 'sourcing_bridge', subject, html, result);
        return result;
    } catch (error) {
        result = { success: false, error: error instanceof Error ? error.message : 'Unknown fatal error' };
        await logEmailAttempt(to, 'sourcing_bridge', subject, html, result).catch(() => {});
        return result;
    }
}

/**
 * Log every email attempt to Firestore for admin visibility.
 */
async function logEmailAttempt(
    to: string,
    template: string,
    subject: string,
    html: string,
    result: { success: boolean; error?: string }
) {
    try {
        const { ensureAdminInitialized, getDb } = await import('@/lib/server/firebase-admin');
        ensureAdminInitialized();
        const db = getDb();
        if (!db) return;

        await db.collection('email_logs').add({
            to,
            from: FROM_EMAIL,
            template,
            subject,
            htmlPreview: html.substring(0, 5000), 
            success: result.success,
            error: result.error || null,
            sentAt: new Date(),
        });
    } catch (e) {
        console.warn('[mailer] Failed to log email attempt:', e);
    }
}

/**
 * Get current email quota status
 */
export function getEmailQuotaStatus(): { sent: number; limit: number; remaining: number } {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
        emailsSentToday = 0;
        lastResetDate = today;
    }
    return {
        sent: emailsSentToday,
        limit: DAILY_LIMIT,
        remaining: Math.max(0, DAILY_LIMIT - emailsSentToday),
    };
}
