import { sendViaBrevo, getBrevoSender } from '@/lib/brevo-mailer';

// Sender identity is owned by the Brevo mailer (src/lib/brevo-mailer.ts);
// this display string is what logEmailAttempt stores in email_logs.from.
const sender = getBrevoSender();
const FROM_DISPLAY = `${sender.name} <${sender.email}>`;

const CANONICAL_DOMAIN = 'https://sedspakistan.live';
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
// Never let a trailing slash from the environment produce `//` in links.
BASE_URL = BASE_URL.replace(/\/+$/, '');

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
    | 'task_feedback'
    | 'task_reviewer_assigned';

/**
 * Generate HTML email content with the SEDS "Mission Command" premium
 * design system (DESIGN_SPEC.md in ~/workspace/email-design): table
 * layout, inline CSS, MSO ghost table, bulletproof CTA, hairline
 * panels, one accent per template. Presentation only: subjects, copy,
 * link targets, the hosted task-qr image, the greeting fallback, and
 * the plain-text fallbacks are exactly what the functional fix (and
 * the contract pinned in mailer-templates.test.ts) established.
 */
export async function generateEmailHtml(
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
): Promise<{ subject: string; html: string; text: string }> {
    const fullLink = data.taskLink.startsWith('http') ? data.taskLink : `${BASE_URL}${data.taskLink}`;
    // Cropped sibling of the production logo (public/assets/logo-email.png).
    // The shared logo.png carries ~70% transparent padding, so at any sane
    // header width the wordmark rendered tiny; the email header points at
    // the cropped copy instead. The original asset is untouched (the site
    // header, tickets, and verify pages keep using it).
    const logoUrl = 'https://sedspakistan.live/assets/logo-email.png';
    // Several callers pass `displayName || email` as the name. An email
    // address must never become the greeting ("Cadet user@example.com,"),
    // so fall back to a neutral address-free form of address.
    const rawRecipientName = (data.recipientName || '').trim();
    const recipientName = rawRecipientName && !rawRecipientName.includes('@')
        ? rawRecipientName
        : 'Team Member';

    // Design palette (DESIGN_SPEC.md section 2). Hairlines do all the
    // dividing; exactly one accent appears per email.
    const palette = {
        page: '#04060C',
        card: '#0A0F1E',
        panel: '#0D1526',
        hairline: '#1C2639',
        ink: '#EDF1F7',
        secondary: '#9AA8BF',
        label: '#7E8CA3',
        footerDim: '#55617A',
        micro: '#454F66',
        middot: '#3A4356',
        amber: '#F59E0B',
    };
    const accents = {
        primary: '#10B981',
        secondary: '#3B82F6',
        accent: '#8B5CF6',
        amber: '#F59E0B',
    };
    // Near-black ink on the accent fill (contrast approx 8:1 on emerald).
    const ctaInk = '#02120B';
    const font = `'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif`;

    let subject = '';
    let headerTitle = '';
    let preheader = '';
    let bodyRows = '';
    let accentColor = accents.primary;
    let text = '';

    // ---- Shared row builders. All layout is table rows: Outlook ignores
    // flex entirely, and box-shadow / gradients do not survive the major
    // clients, so the design earns its presence with spacing and contrast.

    const nameStrong = `<strong style="font-weight: 600;">${recipientName}</strong>`;

    const greetingRow = (greetingHtml: string, introHtml: string) => `
    <tr>
        <td class="px" style="padding: 34px 48px 0 48px; font-family: ${font};">
            <p style="margin: 0; font-size: 16px; line-height: 1.6; color: ${palette.ink};">${greetingHtml}</p>
            <p style="margin: 10px 0 0 0; font-size: 15px; line-height: 1.7; color: ${palette.secondary};">${introHtml}</p>
        </td>
    </tr>`;

    type MetaRow = { label: string; valueHtml: string; valueColor?: string };
    // Open statement rows: a hairline above the first row and between
    // rows, no container box (DESIGN_SPEC.md sections 4 and 5).
    const metaRows = (rows: MetaRow[]) => `
    <tr>
        <td class="px" style="padding: 30px 48px 0 48px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family: ${font};">
                ${rows.map((row, i) => `
                <tr>
                    <td style="padding: 13px 0;${i === 0 ? ` border-top: 1px solid ${palette.hairline};` : ''}${i < rows.length - 1 ? ` border-bottom: 1px solid ${palette.hairline};` : ''} font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: ${palette.label}; vertical-align: top;">${row.label}</td>
                    <td class="meta-value" align="right" style="padding: 13px 0 13px 24px;${i === 0 ? ` border-top: 1px solid ${palette.hairline};` : ''}${i < rows.length - 1 ? ` border-bottom: 1px solid ${palette.hairline};` : ''} font-size: 14px; font-weight: 600; line-height: 1.5; color: ${row.valueColor || palette.ink}; vertical-align: top;">${row.valueHtml}</td>
                </tr>`).join('')}
            </table>
        </td>
    </tr>`;

    // Bulletproof CTA: a VML roundrect for Outlook on Windows, an anchor
    // button for everything else, same URL (DESIGN_SPEC.md section 5).
    const ctaRow = (label: string, accent: string) => {
        const labelHtml = label.replace(/&/g, '&amp;');
        const vmlWidth = Math.ceil(label.length * 8.4) + 76;
        return `
    <tr>
        <td class="px" align="center" style="padding: 34px 48px 46px 48px;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${fullLink}" style="width: ${vmlWidth}px; height: 54px; v-text-anchor: middle;" arcsize="18%" strokecolor="${accent}" fillcolor="${accent}">
                <w:anchorlock/>
                <center style="color: ${ctaInk}; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold;">${labelHtml}</center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-->
            <table role="presentation" align="center" cellpadding="0" cellspacing="0">
                <tr>
                    <td align="center" bgcolor="${accent}" style="background-color: ${accent}; border-radius: 10px;">
                        <a href="${fullLink}" target="_blank" style="display: inline-block; padding: 17px 38px; font-family: ${font}; font-size: 15px; font-weight: 700; letter-spacing: 0.02em; line-height: 1.2; color: ${ctaInk}; text-decoration: none;">${labelHtml}</a>
                    </td>
                </tr>
            </table>
            <!--<![endif]-->
        </td>
    </tr>`;
    };

    // Hairline panel with a 3px accent edge (link callout pattern).
    const panelRow = (innerHtml: string, accent: string) => `
    <tr>
        <td class="px" style="padding: 30px 48px 0 48px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${palette.panel}; border: 1px solid ${palette.hairline}; border-left: 3px solid ${accent}; border-radius: 10px;">
                <tr>
                    <td style="padding: 20px 22px; font-family: ${font};">
                        ${innerHtml}
                    </td>
                </tr>
            </table>
        </td>
    </tr>`;

    switch (template) {
        case 'task_assigned': {
            subject = `🚀 Mission Assignment: ${data.taskTitle}`;
            headerTitle = 'New Directive Assigned';
            accentColor = accents.primary;
            preheader = 'You have been designated as the primary operative for a new mission directive.';
            // QR code so the assignee can scan from desktop email to open the
            // task on their phone. It must be a hosted https image: Gmail and
            // most clients block data: URI images, and Brevo's API has no
            // CID/inline-image support. /api/email/task-qr renders the PNG
            // from this exact link. Only our own https links get a QR.
            const taskQrUrl = fullLink.startsWith(`${BASE_URL}/`) || fullLink === BASE_URL
                ? `${BASE_URL}/api/email/task-qr?link=${encodeURIComponent(fullLink)}`
                : '';
            const rows: MetaRow[] = [{ label: 'Directive', valueHtml: data.taskTitle }];
            if (data.actorName) {
                rows.push({ label: 'Assigned By', valueHtml: data.actorName });
            }
            if (data.dueDate) {
                rows.push({ label: 'Target Deadline', valueHtml: data.dueDate, valueColor: palette.amber });
            }
            const callout = `
    <tr>
        <td class="px" style="padding: 28px 48px 0 48px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${palette.panel}; border: 1px solid ${palette.hairline}; border-left: 3px solid ${accentColor}; border-radius: 10px;">
                <tr>
                    <td style="padding: 20px 22px; font-family: ${font};">
                        <p style="margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: ${palette.label};">Read your full instructions on the platform</p>
                        <p style="margin: 9px 0 0 0; font-size: 14px; line-height: 1.55; font-weight: 600; word-break: break-all;"><a href="${fullLink}" style="color: ${accentColor}; text-decoration: none;">${fullLink}</a></p>
                    </td>
                </tr>
            </table>
        </td>
    </tr>`;
            const note = `
    <tr>
        <td class="px" style="padding: 18px 48px 0 48px; font-family: ${font};">
            <p style="margin: 0; font-size: 13px; line-height: 1.65; color: ${palette.label};">Note: if the chat message disappears, the copy on the platform is the source of truth.</p>
        </td>
    </tr>`;
            // The QR sits on a white tile: the quiet zone scanners need,
            // true contrast for the hosted PNG's dark modules, and a single
            // deliberate focal object on the dark card.
            const qr = taskQrUrl ? `
    <tr>
        <td class="px" align="center" style="padding: 36px 48px 0 48px;">
            <table role="presentation" align="center" cellpadding="0" cellspacing="0">
                <tr>
                    <td align="center" bgcolor="#FFFFFF" style="background-color: #FFFFFF; border-radius: 12px; padding: 16px;">
                        <img src="${taskQrUrl}" alt="Scan to open task" width="144" height="144" style="display: block; width: 144px; height: 144px;">
                    </td>
                </tr>
            </table>
            <p style="margin: 14px 0 0 0; font-family: ${font}; font-size: 12px; line-height: 1.6; color: ${palette.label};">Scan with your phone to open this directive</p>
        </td>
    </tr>` : '';
            bodyRows = greetingRow(`Cadet ${nameStrong},`, preheader)
                + callout
                + note
                + metaRows(rows)
                + qr
                + ctaRow('Acknowledge & View Mission', accentColor);
            text = `Mission Assignment: ${data.taskTitle}\nAssigned by: ${data.actorName || 'Command'}${data.dueDate ? `\nTarget deadline: ${data.dueDate}` : ''}\n\nRead your full instructions on the platform: ${fullLink}\nNote: if the chat message disappears, the copy on the platform is the source of truth.\n\nView details: ${fullLink}`;
            break;
        }

        case 'task_status_change': {
            // The only live caller (notification-service) usually has no
            // from/to statuses at all. Never print "undefined" and never
            // fabricate a transition: show the row only when a real status
            // was passed.
            const fromStatus = data.statusFrom?.trim() || undefined;
            const toStatus = data.statusTo?.trim() || undefined;
            subject = toStatus
                ? `⚡ Status Update: ${data.taskTitle} → ${toStatus}`
                : `⚡ Status Update: ${data.taskTitle}`;
            headerTitle = 'Directive Status Altered';
            accentColor = accents.secondary;
            preheader = 'The operational status of your directive has transitioned.';
            const rows: MetaRow[] = [{ label: 'Directive', valueHtml: data.taskTitle }];
            if (toStatus) {
                rows.push({
                    label: 'Transition',
                    valueHtml: `<span style="color: ${palette.secondary}; text-decoration: line-through;">${fromStatus || 'Unknown'}</span> &nbsp;➔&nbsp; <span style="color: ${accentColor};">${toStatus}</span>`,
                });
            } else if (fromStatus) {
                rows.push({ label: 'Status', valueHtml: fromStatus });
            }
            bodyRows = greetingRow(`Operative ${nameStrong},`, preheader)
                + metaRows(rows)
                + ctaRow('Inspect Directive', accentColor);
            text = `Status Update: ${data.taskTitle}${toStatus ? `\nStatus: ${fromStatus || 'Unknown'} -> ${toStatus}` : fromStatus ? `\nStatus: ${fromStatus}` : ''}\n\nView: ${fullLink}`;
            break;
        }

        case 'task_submitted_for_review': {
            subject = `🛡️ Directive Review Requested: ${data.taskTitle}`;
            headerTitle = 'Quality Assurance Review';
            accentColor = accents.accent;
            preheader = 'An operative has completed operational milestones and requested verification.';
            const rows: MetaRow[] = [{ label: 'Directive', valueHtml: data.taskTitle }];
            if (data.actorName) {
                rows.push({ label: 'Submitted By', valueHtml: data.actorName });
            }
            bodyRows = greetingRow(`Commander ${nameStrong},`, preheader)
                + metaRows(rows)
                + ctaRow('Commence Review', accentColor);
            text = `Review Requested: ${data.taskTitle}${data.actorName ? `\nSubmitted by: ${data.actorName}` : ''}\n\nReview now: ${fullLink}`;
            break;
        }

        case 'task_reviewer_assigned': {
            subject = `🛡️ Reviewer Designation: ${data.taskTitle}`;
            headerTitle = 'Designated Reviewer';
            accentColor = accents.accent;
            preheader = 'You have been designated as the reviewer for a mission directive. When the work is submitted, it comes to you for verification.';
            const rows: MetaRow[] = [{ label: 'Directive', valueHtml: data.taskTitle }];
            if (data.actorName) {
                rows.push({ label: 'Designated By', valueHtml: data.actorName });
            }
            rows.push({ label: 'Your Role', valueHtml: 'Reviewer: you verify the submitted work and approve it or request changes' });
            if (data.dueDate) {
                rows.push({ label: 'Target Deadline', valueHtml: data.dueDate, valueColor: palette.amber });
            }
            bodyRows = greetingRow(`Commander ${nameStrong},`, preheader)
                + metaRows(rows)
                + ctaRow('View Mission', accentColor);
            text = `Reviewer Designation: ${data.taskTitle}\nYour role: Reviewer${data.actorName ? `\nDesignated by: ${data.actorName}` : ''}${data.dueDate ? `\nTarget deadline: ${data.dueDate}` : ''}\n\nView the mission: ${fullLink}`;
            break;
        }

        case 'task_approved': {
            subject = `🏆 Directive Approved & XP Granted: ${data.taskTitle}`;
            headerTitle = 'Mission Accomplished';
            accentColor = accents.primary;
            preheader = 'Your directive submission has met flight standards and been approved by Command.';
            const rows: MetaRow[] = [{ label: 'Directive', valueHtml: data.taskTitle }];
            if (data.actorName) {
                rows.push({ label: 'Verified By', valueHtml: data.actorName });
            }
            bodyRows = greetingRow(`Cadet ${nameStrong},`, preheader)
                + metaRows(rows)
                + ctaRow('View Recognition & Log', accentColor);
            text = `Directive Approved: ${data.taskTitle}${data.actorName ? `\nVerified by: ${data.actorName}` : ''}\n\nView: ${fullLink}`;
            break;
        }

        case 'task_feedback': {
            subject = `⚠️ Action Required: Feedback on ${data.taskTitle}`;
            headerTitle = 'Directive Feedback';
            accentColor = accents.amber;
            preheader = 'Command has provided corrective feedback regarding your submission.';
            const rows: MetaRow[] = [{ label: 'Directive', valueHtml: data.taskTitle }];
            // The feedback quote gets its own accent-edged panel, matching
            // the link callout pattern (DESIGN_SPEC.md section 7).
            const feedback = data.feedbackText
                ? panelRow(`<p style="margin: 0; font-size: 14px; line-height: 1.65; font-style: italic; color: ${palette.ink};">&ldquo;${data.feedbackText}&rdquo;</p>`, accentColor)
                : '';
            bodyRows = greetingRow(`Operative ${nameStrong},`, preheader)
                + metaRows(rows)
                + feedback
                + ctaRow('Review & Revise', accentColor);
            text = `Feedback on: ${data.taskTitle}${data.feedbackText ? `\nNotes: ${data.feedbackText}` : ''}\n\nView: ${fullLink}`;
            break;
        }

        default: {
            subject = `SEDS Mission Command: ${data.taskTitle}`;
            headerTitle = 'Mission Communication';
            preheader = `You have an update regarding ${data.taskTitle}.`;
            bodyRows = greetingRow(
                `Hello ${nameStrong},`,
                `You have an update regarding <strong style="font-weight: 600;">${data.taskTitle}</strong>.`
            ) + ctaRow('Access Terminal', accentColor);
            text = `Mission Update: ${data.taskTitle}\n\nView log: ${fullLink}`;
        }
    }

    const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
    <title>${subject}</title>
    <!--[if mso]>
    <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
    <![endif]-->
    <style>
        :root { color-scheme: dark; }
        html, body { margin: 0 !important; padding: 0 !important; height: 100% !important; width: 100% !important; }
        * { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
        table, td { mso-table-lspace: 0pt !important; mso-table-rspace: 0pt !important; border-collapse: collapse !important; }
        img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
        a { text-decoration: none; }
        .preheader { display: none !important; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0; overflow: hidden; mso-hide: all; }
        @media only screen and (max-width: 640px) {
            .email-container { width: 100% !important; max-width: 100% !important; }
            .px { padding-left: 26px !important; padding-right: 26px !important; }
            .h1 { font-size: 21px !important; }
            .logo-img { width: 128px !important; }
            .meta-value { font-size: 13px !important; }
        }
    </style>
</head>
<body style="margin: 0; padding: 0; word-spacing: normal; background-color: ${palette.page};">
    <div class="preheader" style="display: none; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0; overflow: hidden; mso-hide: all;">${preheader}</div>
    <center role="article" aria-roledescription="email" lang="en" style="width: 100%; background-color: ${palette.page};">
    <div style="max-width: 600px; margin: 0 auto;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${palette.page};">
    <tr>
    <td align="center" style="padding: 48px 12px 56px 12px;">
    <!--[if mso]>
    <table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr><td>
    <![endif]-->
    <table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; background-color: ${palette.card}; border: 1px solid ${palette.hairline}; border-radius: 16px; overflow: hidden;">
        <tr>
            <td class="px" align="center" style="padding: 46px 48px 0 48px;">
                <img class="logo-img" src="${logoUrl}" alt="SEDS Logo" width="148" style="display: block; width: 148px; height: auto;">
            </td>
        </tr>
        <tr>
            <td class="px" align="center" style="padding: 26px 48px 0 48px;">
                <p style="margin: 0; font-family: ${font}; font-size: 11px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: ${palette.label};">Mission Command</p>
                <h1 class="h1" style="margin: 12px 0 0 0; font-family: ${font}; font-size: 23px; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; color: ${palette.ink};">${headerTitle}</h1>
            </td>
        </tr>
        <tr>
            <td align="center" style="padding: 20px 48px 0 48px;">
                <table role="presentation" align="center" width="40" cellpadding="0" cellspacing="0">
                    <tr><td height="2" bgcolor="${accentColor}" style="height: 2px; font-size: 2px; line-height: 2px; border-radius: 2px;">&nbsp;</td></tr>
                </table>
            </td>
        </tr>
        <tr>
            <td class="px" style="padding: 30px 48px 0 48px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr><td height="1" bgcolor="${palette.hairline}" style="height: 1px; font-size: 1px; line-height: 1px;">&nbsp;</td></tr>
                </table>
            </td>
        </tr>
        ${bodyRows}
        <tr>
            <td class="px" style="padding: 0 48px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr><td height="1" bgcolor="${palette.hairline}" style="height: 1px; font-size: 1px; line-height: 1px;">&nbsp;</td></tr>
                </table>
            </td>
        </tr>
        <tr>
            <td class="px" align="center" style="padding: 26px 48px 40px 48px; font-family: ${font};">
                <p style="margin: 0; font-size: 12px; line-height: 1.6; letter-spacing: 0.02em; color: ${palette.label};">SEDS Pakistan Command &amp; Control Terminal</p>
                <p style="margin: 5px 0 0 0; font-size: 11px; line-height: 1.6; color: ${palette.footerDim};">Security Level: encrypted-channel-09</p>
                <p style="margin: 18px 0 0 0; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;">
                    <a href="${BASE_URL}" style="color: ${palette.secondary}; text-decoration: none;">Portal</a>
                    <span style="color: ${palette.middot};">&nbsp;&middot;&nbsp;</span>
                    <a href="${BASE_URL}/privacy-policy" style="color: ${palette.secondary}; text-decoration: none;">Privacy</a>
                    <span style="color: ${palette.middot};">&nbsp;&middot;&nbsp;</span>
                    <a href="mailto:support@sedspakistan.live" style="color: ${palette.secondary}; text-decoration: none;">Support</a>
                </p>
            </td>
        </tr>
    </table>
    <!--[if mso]>
    </td></tr></table>
    <![endif]-->
    <p style="margin: 26px 0 0 0; text-align: center; font-family: ${font}; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: ${palette.micro};">Autogenerated by SEDS-CORE-v2.0 // No reply required</p>
    </td>
    </tr>
    </table>
    </div>
    </center>
</body>
</html>`;

    return { subject, html, text };
}

/**
 * Send an email notification via the Brevo HTTPS API
 * (src/lib/brevo-mailer.ts). Single dispatch path: no SMTP, no Resend
 * fallback — every attempt is logged to email_logs exactly once below.
 */
export async function sendEmailNotification(
    to: string,
    template: EmailTemplate,
    data: Parameters<typeof generateEmailHtml>[1]
): Promise<{ success: boolean; error?: string }> {
    const { subject, html, text } = await generateEmailHtml(template, data);

    let result: { success: boolean; error?: string };
    try {
        result = await sendViaBrevo({ to, subject, html, text });
    } catch (err: any) {
        // sendViaBrevo is specified never to throw; convert defensively so
        // the attempt is still logged and the {success, error} contract holds.
        result = { success: false, error: err?.message || 'Unknown error' };
    }

    if (result.success) {
        emailsSentToday++;
        console.log(`[mailer] Sent ${template} via Brevo to ${to}`);
    } else {
        console.error(`[mailer] Brevo send failed for ${template} to ${to}:`, result.error);
    }
    await logEmailAttempt(to, template, subject, html, result);
    return result;
}

/**
 * Send custom raw HTML/text email via the Brevo HTTPS API
 * (src/lib/brevo-mailer.ts). Single dispatch path: no SMTP, no Resend
 * fallback — every attempt is logged to email_logs exactly once below,
 * always under the 'sourcing_bridge' template label (DESIGN_PLAN §4.3).
 */
export async function sendRawEmail(
    to: string,
    subject: string,
    html: string,
    text?: string
): Promise<{ success: boolean; error?: string }> {
    let result: { success: boolean; error?: string };
    try {
        result = await sendViaBrevo({ to, subject, html, text });
    } catch (err: any) {
        // sendViaBrevo is specified never to throw; convert defensively so
        // the attempt is still logged and the {success, error} contract holds.
        result = { success: false, error: err?.message || 'Unknown fatal error' };
    }

    if (result.success) {
        emailsSentToday++;
        console.log(`[mailer] Sent raw email via Brevo to ${to}`);
    } else {
        console.error(`[mailer] Brevo raw send failed to ${to}:`, result.error);
    }
    await logEmailAttempt(to, 'sourcing_bridge', subject, html, result);
    return result;
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
            from: FROM_DISPLAY,
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
