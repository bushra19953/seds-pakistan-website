import { sendViaBrevo } from '@/lib/brevo-mailer';

/**
 * PRODUCTION-GRADE EMAIL SERVICE
 * Sends via the Brevo HTTPS API (src/lib/brevo-mailer.ts) — the single
 * transport for the whole codebase. The previous transports are deleted,
 * not disabled: SMTP (blocked on Render's free tier), the Resend API
 * (no key configured in production), and the mock mode that returned
 * success without sending anything.
 */

interface EmailPayload {
    to: string;
    subject: string;
    text?: string;
    html: string;
}

class EmailService {
    /**
     * Send an email via Brevo. Returns a truthful result: an unconfigured
     * or failed send is `false`, never a fake success.
     */
    async sendEmail(payload: EmailPayload): Promise<boolean> {
        const result = await sendViaBrevo({
            to: payload.to, subject: payload.subject, html: payload.html, text: payload.text,
        });
        if (!result.success) console.error(`[EmailService] Brevo send failed to ${payload.to}:`, result.error);
        return result.success;
    }
}

export const emailService = new EmailService();
