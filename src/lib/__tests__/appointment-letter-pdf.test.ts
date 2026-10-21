/**
 * Suite G-core: appointment letter renderer content (spec G.5.2/G.9).
 *
 * jsPDF is replaced with a recording fake so the assertions run on the
 * exact strings the renderer emits: masthead status line, personnel
 * stack, authority sentence, ratification variant (a) only when
 * required, term line only when set, acceptance instruction quoting
 * the code, QR verification URL drawn as a clickable link, hash short
 * form in the footer, and the status banner when the letter is not a
 * clean original. (The real-jsPDF byte output is covered by the
 * letter route test's %PDF magic-bytes assertion.)
 */

import { renderAppointmentLetterPDF } from '@/lib/appointment-letter-pdf';
import type { AppointmentLetterData } from '@/types/appointment-instrument';

const recorded = {
  texts: [] as string[],
  links: [] as Array<{ url: string }>,
  images: 0,
};

class FakeJsPDF {
  private fontSize = 11;
  constructor(_opts: unknown) {}
  setFont() {}
  setFontSize(size: number) {
    this.fontSize = size;
  }
  setTextColor() {}
  setDrawColor() {}
  setLineWidth() {}
  line() {}
  addImage() {
    recorded.images += 1;
  }
  link(_x: number, _y: number, _w: number, _h: number, opts: { url: string }) {
    recorded.links.push({ url: opts.url });
  }
  getTextWidth(text: string) {
    return text.length * this.fontSize * 0.5;
  }
  splitTextToSize(text: string, maxWidth: number): string[] {
    const maxChars = Math.max(8, Math.floor(maxWidth / (this.fontSize * 0.5)));
    const words = String(text).split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const trial = current ? `${current} ${word}` : word;
      if (trial.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = trial;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }
  text(value: string | string[]) {
    if (Array.isArray(value)) recorded.texts.push(...value);
    else recorded.texts.push(value);
  }
  output() {
    return new ArrayBuffer(16);
  }
}

jest.mock('jspdf', () => ({ jsPDF: FakeJsPDF }));
jest.mock('qrcode', () => ({
  __esModule: true,
  default: { toDataURL: async () => 'data:image/png;base64,AAAA' },
}));

const VERIFY_URL =
  'https://sedspakistan.live/verify-appointment/SEDS-PK-APT-ABC23';

function letterData(overrides: Partial<AppointmentLetterData> = {}): AppointmentLetterData {
  return {
    instrumentNumber: 'APT-inst1',
    verificationCode: 'SEDS-PK-APT-ABC23',
    verificationUrl: VERIFY_URL,
    contentHashShort: 'abcdef0123456789',
    issuedDateLine: '2 October 2026',
    appointeeName: 'Ayesha Khan',
    roleDisplayName: 'National Treasurer',
    chapterName: null,
    appointedByName: 'Muhammad Zubair Mongol',
    appointedByOffice: 'Founder',
    authorityReference: 'Constitution 7.3; Role Catalog 6.1',
    effectiveFromLine: '1 October 2026',
    termEndsAtLine: null,
    catalogReference: 'Role Catalog 6.1',
    ratificationRequired: true,
    registrationStatusLine:
      'SEDS Pakistan is an independent student-led aerospace engineering initiative. Its registration under the Societies Registration Act 1860 (Act XXI of 1860) is currently in process.',
    statusLine: null,
    ...overrides,
  };
}

function allText(): string {
  return recorded.texts.join('\n');
}

beforeEach(() => {
  recorded.texts = [];
  recorded.links = [];
  recorded.images = 0;
});

describe('renderAppointmentLetterPDF', () => {
  it('renders the full letter for a ratification-required office', async () => {
    const buf = await renderAppointmentLetterPDF(letterData());
    expect(Buffer.isBuffer(buf)).toBe(true);
    const text = allText();
    expect(text).toContain('SEDS PAKISTAN');
    expect(text).toContain('currently in process');
    expect(text).toContain('Appointment Letter');
    expect(text).toContain('APT-inst1');
    expect(text).toContain('SEDS-PK-APT-ABC23');
    expect(text).toContain('Ayesha Khan');
    expect(text).toContain('National Treasurer');
    expect(text).toContain('Muhammad Zubair Mongol');
    expect(text).toContain('Founder');
    expect(text).toContain('Constitution 7.3; Role Catalog 6.1');
    // Ratification variant (a), key phrases.
    expect(text).toContain('subject to ratification by the Board of Governors');
    expect(text).toContain('stands ratified');
    // Acceptance instruction quotes the code.
    expect(text).toContain('quoting verification code SEDS-PK-APT-ABC23');
    // Footer hash short form.
    expect(text).toContain('abcdef0123456789');
    // QR image drawn and the verification URL is a clickable link.
    expect(recorded.images).toBe(1);
    expect(recorded.links.some((l) => l.url === VERIFY_URL)).toBe(true);
    // At-pleasure office: no term line.
    expect(text).not.toContain('Term ends:');
  });

  it('omits the ratification paragraph when ratification is not required', async () => {
    await renderAppointmentLetterPDF(letterData({ ratificationRequired: false }));
    expect(allText()).not.toContain('subject to ratification');
  });

  it('prints the term line only when a term end is set', async () => {
    await renderAppointmentLetterPDF(
      letterData({ termEndsAtLine: '1 October 2029' }),
    );
    const text = allText();
    expect(text).toContain('Term ends:');
    expect(text).toContain('1 October 2029');
  });

  it('prints the status banner when the letter is superseded', async () => {
    await renderAppointmentLetterPDF(
      letterData({
        statusLine: 'This letter has been superseded by a corrected letter.',
      }),
    );
    expect(allText()).toContain('superseded by a corrected letter');
  });

  it('prints the chapter in the stack and authority sentence when set', async () => {
    await renderAppointmentLetterPDF(
      letterData({ chapterName: 'IST Chapter' }),
    );
    const text = allText();
    expect(text).toContain('IST Chapter');
    expect(text).toContain('(IST Chapter)');
  });
});
