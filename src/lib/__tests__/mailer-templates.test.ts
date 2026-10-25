/**
 * @jest-environment node
 *
 * mailer-templates.test.ts — functional contract for every email template
 * in src/lib/mailer.ts, written after the 2026-10-25 Gmail delivery proof:
 * the task_assigned QR rendered as a broken image because it was embedded
 * as a data: URI (QRCode.toDataURL), which Gmail blocks. These tests pin
 * the functional surface of all templates so that class of defect cannot
 * regress:
 *
 * - no data: URI image sources anywhere in outgoing HTML;
 * - every href is absolute on https://sedspakistan.live (or a mailto: on
 *   the same domain);
 * - the task_assigned QR is the hosted /api/email/task-qr image whose
 *   `link` parameter decodes to exactly the task link it must encode;
 * - every template ships a non-empty plain-text fallback containing the
 *   task link, and neither subject nor text leaks "undefined" or an HTML
 *   entity such as &amp; (subjects and text are plain text in clients).
 */

process.env.BREVO_API_KEY = process.env.BREVO_API_KEY || 'test-key';

import { generateEmailHtml, type EmailTemplate } from '@/lib/mailer';

const ORIGIN = 'https://sedspakistan.live';
const TASK_LINK = '/profile/unified?uid=cadet-1&task=task-9';
const FULL_LINK = `${ORIGIN}${TASK_LINK}`;

const FULL_DATA = {
  recipientName: 'Cadet Test',
  taskTitle: 'Test Directive',
  taskLink: TASK_LINK,
  actorName: 'Command',
  statusFrom: 'Pending',
  statusTo: 'In Progress',
  feedbackText: 'Please tighten the report formatting.',
  dueDate: 'Sun, Oct 26, 2026, 5:30 PM',
};

/** Same data with every optional field omitted. */
const MINIMAL_DATA = {
  recipientName: 'Cadet Test',
  taskTitle: 'Test Directive',
  taskLink: TASK_LINK,
};

const TEMPLATES: EmailTemplate[] = [
  'task_assigned',
  'task_status_change',
  'task_submitted_for_review',
  'task_approved',
  'task_feedback',
];

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

function imgSrcsOf(html: string): string[] {
  return [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
}

describe.each(TEMPLATES)('template %s', (template) => {
  it('contains no data: URI image source', async () => {
    const { html } = await generateEmailHtml(template, FULL_DATA);
    expect(html).not.toContain('src="data:');
    for (const src of imgSrcsOf(html)) {
      expect(src.startsWith('https://')).toBe(true);
    }
  });

  it('every href is absolute on sedspakistan.live or a same-domain mailto', async () => {
    const { html } = await generateEmailHtml(template, FULL_DATA);
    const hrefs = hrefsOf(html);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      if (href.startsWith('mailto:')) {
        expect(href).toBe('mailto:support@sedspakistan.live');
      } else {
        expect(href.startsWith(`${ORIGIN}/`) || href === ORIGIN).toBe(true);
      }
    }
    // The primary call-to-action points at the real task link.
    expect(hrefs).toContain(FULL_LINK);
  });

  it('footer links are live targets (privacy-policy, no stale seds.pk)', async () => {
    const { html } = await generateEmailHtml(template, FULL_DATA);
    expect(html).toContain(`${ORIGIN}/privacy-policy`);
    expect(html).not.toContain('seds.pk');
    expect(html).not.toContain(`${ORIGIN}/privacy"`);
  });

  it('ships a plain-text fallback containing the task link and no leaked values', async () => {
    for (const data of [FULL_DATA, MINIMAL_DATA]) {
      const { subject, text } = await generateEmailHtml(template, data);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(FULL_LINK);
      expect(text).not.toContain('undefined');
      expect(subject.length).toBeGreaterThan(0);
      expect(subject).not.toContain('undefined');
      // Subjects are plain text in mail clients: no HTML entities.
      expect(subject).not.toContain('&amp;');
    }
  });
});

describe('B2: task_status_change with the production caller shape', () => {
  // Exactly what src/lib/server/notification-service.ts passes when the
  // payload metadata carries no statuses (every current production send).
  // Before the fix this rendered "undefined" in subject, body and text.
  const CALLER_SHAPE = {
    recipientName: 'Cadet Test',
    taskTitle: 'Test Directive',
    taskLink: TASK_LINK,
    actorName: 'Mission Control',
  };

  it('prints no "undefined" and fabricates no transition', async () => {
    const { subject, html, text } = await generateEmailHtml('task_status_change', CALLER_SHAPE);
    expect(subject).toBe('⚡ Status Update: Test Directive');
    expect(subject).not.toContain('undefined');
    expect(html).not.toContain('undefined');
    expect(text).not.toContain('undefined');
    expect(html).not.toContain('Transition:');
  });

  it('renders the real transition end to end when statuses are passed', async () => {
    const { subject, html, text } = await generateEmailHtml('task_status_change', {
      ...CALLER_SHAPE,
      statusFrom: 'Pending',
      statusTo: 'In Progress',
    });
    expect(subject).toBe('⚡ Status Update: Test Directive → In Progress');
    expect(html).toContain('Pending');
    expect(html).toContain('In Progress');
    expect(text).toContain('Status: Pending -> In Progress');
  });
});

describe('D4: greeting never becomes an email address', () => {
  it('falls back to a neutral form of address when the name is an email', async () => {
    const { html } = await generateEmailHtml('task_assigned', {
      ...MINIMAL_DATA,
      recipientName: 'cadet@example.com',
    });
    expect(html).not.toContain('cadet@example.com');
    expect(html).toContain('Team Member');
  });
});

describe('task_assigned QR code', () => {
  it('is the hosted task-qr image encoding exactly the task link', async () => {
    const { html } = await generateEmailHtml('task_assigned', FULL_DATA);
    const qrSrc = imgSrcsOf(html).find((src) => src.includes('/api/email/task-qr'));
    expect(qrSrc).toBeDefined();
    const url = new URL(qrSrc as string);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/api/email/task-qr');
    // The QR must decode to the same URL the email prints and buttons use.
    expect(url.searchParams.get('link')).toBe(FULL_LINK);
  });

  it('never falls back to an inline data: QR', async () => {
    const { html } = await generateEmailHtml('task_assigned', MINIMAL_DATA);
    expect(html).not.toContain('data:image');
  });
});
