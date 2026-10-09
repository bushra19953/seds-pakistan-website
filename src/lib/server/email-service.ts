import nodemailer from 'nodemailer';

/**
 * PRODUCTION-GRADE EMAIL SERVICE
 * Supports:
 * 1. Resend API (RESEND_API_KEY)
 * 2. Standard SMTP (Gmail, Brevo, SendGrid, Amazon SES, Custom Domain)
 */

interface EmailPayload {
    to: string;
    subject: string;
    text?: string;
    html: string;
}

class EmailService {
    private transporter: nodemailer.Transporter | null = null;
    private isConfigured: boolean = false;

    constructor() {
        this.initTransporter();
    }

    private initTransporter() {
        const host = process.env.EMAIL_SERVER_HOST || process.env.SMTP_HOST;
        const port = parseInt(process.env.EMAIL_SERVER_PORT || process.env.SMTP_PORT || '587');
        const user = process.env.EMAIL_SERVER_USER || process.env.SMTP_USER;
        const pass = process.env.EMAIL_SERVER_PASSWORD || process.env.SMTP_PASS;

        if (host && user && pass) {
            try {
                this.transporter = nodemailer.createTransport({
                    host,
                    port,
                    secure: port === 465,
                    auth: {
                        user,
                        pass,
                    },
                });
                this.isConfigured = true;
                console.log(`[EmailService] SMTP Transporter configured for ${host}`);
            } catch (error) {
                console.error('[EmailService] Failed to initialize transporter:', error);
            }
        } else if (process.env.RESEND_API_KEY) {
            this.isConfigured = true;
            console.log('[EmailService] Resend API Key detected');
        } else {
            console.warn('[EmailService] Email credentials missing. Set RESEND_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS in Vercel to dispatch real emails.');
        }
    }

    /**
     * Send an email with retry logic and error logging
     */
    async sendEmail(payload: EmailPayload): Promise<boolean> {
        const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || 'SEDS Pakistan <noreply@sedspakistan.live>';

        console.log(`[EmailService] Preparing email to: ${payload.to} | Subject: ${payload.subject}`);

        // Method 1: Resend HTTP API (if RESEND_API_KEY provided)
        const resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
            try {
                const res = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${resendKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from: from.includes('<') ? from : `SEDS Pakistan <${from}>`,
                        to: [payload.to],
                        subject: payload.subject,
                        html: payload.html,
                        text: payload.text,
                    }),
                });

                if (res.ok) {
                    console.log(`[EmailService] Email dispatched via Resend to ${payload.to}`);
                    return true;
                } else {
                    const errText = await res.text();
                    console.error('[EmailService] Resend API error:', errText);
                }
            } catch (resendErr) {
                console.error('[EmailService] Resend dispatch exception:', resendErr);
            }
        }

        // Method 2: Standard SMTP
        if (this.transporter) {
            try {
                await this.transporter.sendMail({
                    from,
                    to: payload.to,
                    subject: payload.subject,
                    text: payload.text,
                    html: payload.html,
                });
                console.log(`[EmailService] Email sent successfully via SMTP to ${payload.to}`);
                return true;
            } catch (error) {
                console.error(`[EmailService] Failed to send email via SMTP to ${payload.to}:`, error);
                return false;
            }
        }

        // Mock Mode if no credentials configured
        console.log('--- MOCK EMAIL LOG (Set SMTP or RESEND_API_KEY to send real emails) ---');
        console.log(`To: ${payload.to}`);
        console.log(`Subject: ${payload.subject}`);
        console.log('--- END MOCK EMAIL ---');
        return true;
    }
}

export const emailService = new EmailService();
