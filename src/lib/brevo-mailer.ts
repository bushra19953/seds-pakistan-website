/**
 * Brevo HTTPS mailer (server-only).
 *
 * Why this module exists: production runs on Render's free tier, which blocks
 * outbound SMTP. The previous transports (nodemailer SMTP in
 * `src/lib/mailer.ts` and `src/lib/server/email-service.ts`) can therefore
 * never deliver from production. This module sends through Brevo's HTTPS
 * transactional API instead:
 *
 *   POST https://api.brevo.com/v3/smtp/email
 *   header: api-key: <BREVO_API_KEY>
 *
 * Guarantees:
 * - FROM is preserved: noreply@sedspakistan.live, display name "SEDS Pakistan"
 *   (the name both previous senders used).
 * - No Firestore (or any other service) is imported or touched at module
 *   load, or anywhere in this file. Email-attempt logging is delegated to a
 *   hook registered by the caller (see `setEmailLogHook` below); Implementer C
 *   wires the Firestore `email_logs` writer to that hook.
 * - `BREVO_API_KEY` is read from `process.env` at call time (never cached at
 *   module load, never logged). A missing/empty key is a loud failure whose
 *   error names BREVO_API_KEY; it is never a silent no-op.
 * - Every failure mode surfaces: missing key, Brevo non-2xx (HTTP status plus
 *   Brevo's own error message preserved), and network/timeout errors all come
 *   back as `{ success: false, error }` results.
 */

export const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
export const BREVO_FROM_EMAIL = 'noreply@sedspakistan.live';
export const BREVO_FROM_NAME = 'SEDS Pakistan';
/** Plan-name aliases (DESIGN_PLAN.md §2.1) for the same sender constants. */
export const BREVO_SENDER_EMAIL = BREVO_FROM_EMAIL;
export const BREVO_SENDER_NAME = BREVO_FROM_NAME;

/** True iff `BREVO_API_KEY` is set and non-empty (after trim). Read live. */
export function isBrevoConfigured(): boolean {
    return (process.env.BREVO_API_KEY || '').trim().length > 0;
}

/**
 * The canonical sender identity (DESIGN_PLAN.md §2.1):
 * - email: the `BREVO_FROM_EMAIL` constant, unless `EMAIL_FROM` is set and
 *   an address can be extracted from it (the address inside `<...>` if
 *   present, else the trimmed value if it contains '@'); a malformed
 *   `EMAIL_FROM` never reaches Brevo - the constant wins.
 * - name: `SMTP_FROM_NAME` if set (it exists in the Render env and is read
 *   by no legacy code), else 'SEDS Pakistan'.
 */
export function getBrevoSender(): { name: string; email: string } {
    let email = BREVO_FROM_EMAIL;
    const emailFrom = (process.env.EMAIL_FROM || '').trim();
    if (emailFrom) {
        const angled = emailFrom.match(/<([^<>\s]+@[^<>\s]+)>/);
        if (angled) email = angled[1];
        else if (emailFrom.includes('@') && !/\s/.test(emailFrom)) email = emailFrom;
    }
    const name = (process.env.SMTP_FROM_NAME || '').trim() || BREVO_FROM_NAME;
    return { name, email };
}

const BREVO_REQUEST_TIMEOUT_MS = 30_000;

/** A recipient may be a bare address, a "Name <address>" string, or an object. */
export type BrevoRecipient = string | { email: string; name?: string };

/**
 * Attachment input, accepting both Brevo-style and nodemailer-style shapes.
 * `content` may be a string, Buffer, or Uint8Array. Strings are treated as
 * UTF-8 text and base64-encoded, unless `contentEncoding: 'base64'` says the
 * string is already base64. A `url` attachment is passed through untouched
 * (Brevo fetches it). `contentType` is accepted for nodemailer compatibility
 * but is NOT sent: the Brevo API has no per-attachment content-type field
 * (it infers the type from the file name) - see IMPL_A.md.
 */
export interface BrevoAttachmentInput {
    name?: string;
    filename?: string;
    content?: string | Buffer | Uint8Array;
    contentEncoding?: 'base64' | 'utf8';
    contentType?: string;
    url?: string;
}

export interface BrevoSendOptions {
    /** Single address, "Name <address>", or a list of either / recipient objects. */
    to: BrevoRecipient | BrevoRecipient[];
    cc?: BrevoRecipient | BrevoRecipient[];
    bcc?: BrevoRecipient | BrevoRecipient[];
    /** Brevo takes a single reply-to address. */
    replyTo?: BrevoRecipient;
    subject: string;
    /** Maps to Brevo `htmlContent`. At least one of html / text is required. */
    html?: string;
    /** Maps to Brevo `textContent`. */
    text?: string;
    attachments?: BrevoAttachmentInput[];
    /**
     * Sender override. Defaults to `getBrevoSender()`:
     * `{ email: 'noreply@sedspakistan.live', name: 'SEDS Pakistan' }`
     * (subject to the §2.1 env overrides documented there).
     * A string may be a bare address or "Name <address>".
     */
    sender?: BrevoRecipient;
    /** Extra Brevo headers, passed through verbatim. */
    headers?: Record<string, string>;
    /** Brevo tags, passed through verbatim. */
    tags?: string[];
    /**
     * Label recorded with the logging hook for this attempt (for example
     * 'task_assigned' or 'sourcing_bridge'), matching the `template` field
     * the old mailer wrote to `email_logs`. Not sent to Brevo.
     * Defaults to 'custom'.
     */
    template?: string;
}

/**
 * The DESIGN_PLAN.md §1 input shape. `sendViaBrevo` accepts the richer
 * `BrevoSendOptions` superset; every `BrevoSendInput` value is assignable
 * to it unchanged.
 */
export interface BrevoSendInput {
    to: string;
    subject: string;
    html: string;
    text?: string;
}

export interface BrevoSendResult {
    success: boolean;
    /** Present on failure; names the cause (missing key, HTTP status, network). */
    error?: string;
    /** Brevo's messageId, present on success when Brevo returns one. */
    messageId?: string;
    /** HTTP status returned by Brevo, when a response was received. */
    status?: number;
}

/**
 * One email-attempt record, handed to the registered log hook after every
 * send attempt (success or failure). Field names mirror the arguments of the
 * internal `logEmailAttempt(to, template, subject, html, result)` in
 * `src/lib/mailer.ts`, so the existing `email_logs` shape can be reproduced
 * by the hook implementation without changes here.
 */
export interface BrevoEmailLogEntry {
    /** Primary recipients as bare addresses, joined with ', '. */
    to: string;
    from: string;
    template: string;
    subject: string;
    html: string;
    result: { success: boolean; error?: string };
    provider: 'brevo';
    messageId?: string;
    status?: number;
}

export type BrevoEmailLogHook = (entry: BrevoEmailLogEntry) => Promise<void> | void;

/**
 * LOGGING HOOK POINT (for Implementer C): the single registered hook below is
 * invoked once per send attempt by `emitEmailLog` inside `sendViaBrevo`,
 * after the attempt's outcome is known and before the result is returned.
 * Default is no hook (attempts are not persisted by this module). Register
 * the Firestore `email_logs` writer with `setEmailLogHook(...)`; hook errors
 * are caught and only warned about, they never change the send result.
 * This module itself never imports Firestore.
 */
let emailLogHook: BrevoEmailLogHook | null = null;

export function setEmailLogHook(hook: BrevoEmailLogHook | null): void {
    emailLogHook = hook;
}

export function getEmailLogHook(): BrevoEmailLogHook | null {
    return emailLogHook;
}

async function emitEmailLog(entry: BrevoEmailLogEntry): Promise<void> {
    if (!emailLogHook) return;
    try {
        await emailLogHook(entry);
    } catch (e) {
        console.warn('[brevo-mailer] Email log hook failed:', e);
    }
}

let brevoEmailsSent = 0;

/** Successful sends through this module in this process (diagnostics only). */
export function getBrevoSendCount(): number {
    return brevoEmailsSent;
}

function parseRecipient(input: BrevoRecipient): { email: string; name?: string } {
    if (typeof input !== 'string') {
        return input.name ? { email: input.email, name: input.name } : { email: input.email };
    }
    const angled = input.match(/^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/);
    if (angled) {
        const name = angled[1].replace(/^"|"$/g, '').trim();
        return name ? { email: angled[2], name } : { email: angled[2] };
    }
    return { email: input.trim() };
}

function normalizeRecipients(
    input: BrevoRecipient | BrevoRecipient[] | undefined
): { email: string; name?: string }[] {
    if (!input) return [];
    const list = Array.isArray(input) ? input : [input];
    const out: { email: string; name?: string }[] = [];
    for (const item of list) {
        // A single string may carry several comma-separated addresses
        // (nodemailer accepted that form), so split before parsing.
        const parts = typeof item === 'string' ? item.split(',') : [item];
        for (const part of parts) {
            const parsed = parseRecipient(part as BrevoRecipient);
            if (parsed.email) out.push(parsed);
        }
    }
    return out;
}

function toBase64(content: string | Buffer | Uint8Array, encoding?: 'base64' | 'utf8'): string {
    if (typeof content === 'string') {
        return encoding === 'base64' ? content : Buffer.from(content, 'utf8').toString('base64');
    }
    return Buffer.from(content).toString('base64');
}

function buildBrevoPayload(options: BrevoSendOptions): Record<string, unknown> {
    const sender = options.sender ? parseRecipient(options.sender) : getBrevoSender();

    const payload: Record<string, unknown> = {
        sender,
        to: normalizeRecipients(options.to),
        subject: options.subject,
        // DESIGN_PLAN.md §1 body shape: both content keys are always sent;
        // a text-only send passes htmlContent: '' (Brevo accepts that
        // alongside textContent), a html-only send passes textContent: ''.
        htmlContent: options.html ?? '',
        textContent: options.text ?? '',
    };

    const cc = normalizeRecipients(options.cc);
    if (cc.length > 0) payload.cc = cc;
    const bcc = normalizeRecipients(options.bcc);
    if (bcc.length > 0) payload.bcc = bcc;
    if (options.replyTo) payload.replyTo = parseRecipient(options.replyTo);

    if (options.attachments && options.attachments.length > 0) {
        const attachment: Record<string, string>[] = [];
        for (const att of options.attachments) {
            const name = att.name || att.filename || 'attachment';
            if (att.url) {
                attachment.push({ name, url: att.url });
            } else if (att.content !== undefined) {
                attachment.push({ name, content: toBase64(att.content, att.contentEncoding) });
            }
        }
        if (attachment.length > 0) payload.attachment = attachment;
    }

    if (options.headers && Object.keys(options.headers).length > 0) payload.headers = options.headers;
    if (options.tags && options.tags.length > 0) payload.tags = options.tags;

    return payload;
}

/**
 * Core Brevo send. Never throws for send failures: every failure is returned
 * as `{ success: false, error }` so existing callers that branch on a result
 * object (the `src/lib/mailer.ts` convention) keep working unchanged.
 */
export async function sendViaBrevo(options: BrevoSendOptions): Promise<BrevoSendResult> {
    const template = options.template || 'custom';
    const toList = normalizeRecipients(options.to);
    const toForLog = toList.map((r) => r.email).join(', ');
    const fromForLog = options.sender ? parseRecipient(options.sender).email : getBrevoSender().email;

    const finish = async (result: BrevoSendResult): Promise<BrevoSendResult> => {
        await emitEmailLog({
            to: toForLog,
            from: fromForLog,
            template,
            subject: options.subject,
            html: options.html || '',
            result: { success: result.success, error: result.error },
            provider: 'brevo',
            messageId: result.messageId,
            status: result.status,
        });
        return result;
    };

    // Read at call time: a key set/rotated after module load must take effect,
    // and a missing key must fail loudly, never silently drop the email.
    const apiKey = (process.env.BREVO_API_KEY || '').trim();
    if (!apiKey) {
        // Exact error string specified by DESIGN_PLAN.md §5; callers and the
        // admin email-logs UI surface it verbatim.
        return finish({ success: false, error: 'BREVO_API_KEY is not configured' });
    }

    if (toList.length === 0) {
        return finish({ success: false, error: 'Brevo send failed: no recipients (to is empty).' });
    }
    if (!options.html && !options.text) {
        return finish({ success: false, error: 'Brevo send failed: both html and text content are empty.' });
    }

    const payload = buildBrevoPayload(options);

    let res: Response;
    try {
        res = await fetch(BREVO_API_URL, {
            method: 'POST',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(BREVO_REQUEST_TIMEOUT_MS),
        });
    } catch (err) {
        // DESIGN_PLAN.md §1: a fetch throw surfaces as the error's own message.
        const message = err instanceof Error ? err.message : 'Unknown network error';
        return finish({ success: false, error: message });
    }

    if (!res.ok) {
        // Brevo error bodies look like { code: string, message: string }.
        // Preserve both the HTTP status and Brevo's message in the error.
        let brevoMessage = '';
        try {
            const bodyText = await res.text();
            try {
                const parsed = JSON.parse(bodyText) as { message?: string; code?: string };
                brevoMessage = parsed.message || parsed.code || bodyText;
            } catch {
                brevoMessage = bodyText;
            }
        } catch {
            brevoMessage = '';
        }
        const detail = brevoMessage.trim().slice(0, 500) || res.statusText || 'no error detail returned';
        return finish({
            success: false,
            status: res.status,
            // Format specified by DESIGN_PLAN.md §1:
            // `Brevo API <status>: <Brevo message/code or statusText>`.
            error: `Brevo API ${res.status}: ${detail}`,
        });
    }

    let messageId: string | undefined;
    try {
        const body = (await res.json()) as { messageId?: string };
        messageId = body.messageId;
    } catch {
        // A 2xx with an empty/non-JSON body is still a successful send.
    }

    brevoEmailsSent++;
    console.log(`[brevo-mailer] Sent ${template} via Brevo to ${toForLog}`);
    return finish({ success: true, status: res.status, messageId });
}

/** Alias for `sendViaBrevo`, for callers that prefer the provider-verb name. */
export const sendBrevoEmail = sendViaBrevo;

/**
 * Drop-in transport replacement for `sendRawEmail` in `src/lib/mailer.ts`:
 * identical first four parameters and identical return shape
 * (`{ success, error? }`), now delivered via Brevo instead of SMTP/Resend.
 * The optional fifth parameter only ADDS Brevo capabilities (cc/bcc/replyTo/
 * attachments/log template label); existing 4-argument call sites are
 * unaffected.
 */
export async function sendRawEmail(
    to: string,
    subject: string,
    html: string,
    text?: string,
    extra?: Pick<BrevoSendOptions, 'cc' | 'bcc' | 'replyTo' | 'attachments' | 'sender' | 'headers' | 'tags'> & {
        template?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const result = await sendViaBrevo({
        to,
        subject,
        html,
        text,
        cc: extra?.cc,
        bcc: extra?.bcc,
        replyTo: extra?.replyTo,
        attachments: extra?.attachments,
        sender: extra?.sender,
        headers: extra?.headers,
        tags: extra?.tags,
        template: extra?.template || 'sourcing_bridge',
    });
    return result.success ? { success: true } : { success: false, error: result.error };
}

/**
 * Drop-in transport replacement for `EmailService.sendEmail` in
 * `src/lib/server/email-service.ts`: same payload shape
 * (`{ to, subject, text?, html }`) and same `Promise<boolean>` return.
 * Unlike the old service there is no mock mode: an unconfigured or failed
 * send returns false instead of pretending the email went out.
 */
export async function sendEmail(payload: {
    to: string;
    subject: string;
    text?: string;
    html: string;
}): Promise<boolean> {
    const result = await sendViaBrevo({
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        template: 'notification',
    });
    return result.success;
}

// Startup signal (DESIGN_PLAN.md §5): importing this module at server start
// logs ONE loud line when the key is absent. It must not throw - the site
// stays up; every send simply fails with the §5 error until the key is set.
if (!isBrevoConfigured()) {
    console.error('[brevo-mailer] BREVO_API_KEY is not configured — all email sending will fail until it is set in the environment.');
}
