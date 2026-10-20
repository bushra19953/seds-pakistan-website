/**
 * Workstream 7 coverage for Urdu / Unicode fonts and the AI assistant
 * backend. Static source assertions, following the repo pattern in
 * task-pdf-cover-role-lines.test.ts and version-guard.test.ts:
 *
 * Fonts:
 *   (a) the root layout loads Noto Sans and Noto Nastaliq Urdu through
 *       next/font with display swap and exposes both as CSS variables;
 *   (b) Noto Nastaliq Urdu loads the arabic subset (the Urdu glyphs);
 *   (c) the html element carries both font variables and declares UTF-8;
 *   (d) global CSS routes the brand stacks through Noto fallbacks and
 *       defines the .font-urdu / .font-unicode utilities plus an RTL rule;
 *   (e) Tailwind exposes urdu and unicode font family utilities.
 *
 * AI assistant backend:
 *   (f) /api/ai/assistant exists, uses the server key pool
 *       (executeWithFailover), and contains no hardcoded Gemini key;
 *   (g) the study assistant component posts to /api/ai/assistant, no
 *       longer blocks on a client Gemini key, and its topic input and
 *       submit button are enabled.
 *
 * No em dashes are used in this file.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const LAYOUT = read('src/app/layout.tsx');
const GLOBALS = read('src/app/globals.css');
const TAILWIND = read('tailwind.config.ts');
const ASSISTANT_ROUTE = read('src/app/api/ai/assistant/route.ts');
const STUDY_SECTION = read('src/components/sections/study-assistant-section.tsx');

describe('WS7 Urdu and Unicode fonts', () => {
  test('layout imports Noto Sans and Noto Nastaliq Urdu from next/font/google', () => {
    expect(LAYOUT).toContain('Noto_Nastaliq_Urdu');
    expect(LAYOUT).toContain('Noto_Sans');
    expect(LAYOUT).toContain("from 'next/font/google'");
  });

  test('both Noto fonts use display swap and expose CSS variables', () => {
    const notoSansBlock = LAYOUT.slice(
      LAYOUT.indexOf('const notoSans'),
      LAYOUT.indexOf('const notoNastaliq')
    );
    const notoNastaliqBlock = LAYOUT.slice(LAYOUT.indexOf('const notoNastaliq'));
    expect(notoSansBlock).toContain("display: 'swap'");
    expect(notoSansBlock).toContain("variable: '--font-noto-sans'");
    expect(notoNastaliqBlock).toContain("display: 'swap'");
    expect(notoNastaliqBlock).toContain("variable: '--font-noto-nastaliq'");
  });

  test('Noto Nastaliq Urdu loads the arabic subset that carries Urdu glyphs', () => {
    const notoNastaliqBlock = LAYOUT.slice(LAYOUT.indexOf('const notoNastaliq'));
    expect(notoNastaliqBlock).toContain("'arabic'");
  });

  test('html element carries both font variables', () => {
    expect(LAYOUT).toContain('notoSans.variable');
    expect(LAYOUT).toContain('notoNastaliq.variable');
  });

  test('UTF-8 charset is declared in the root layout', () => {
    expect(LAYOUT).toMatch(/charSet\s*=\s*["']utf-8["']/i);
  });

  test('global font stacks end in Noto fallbacks on every brand variable', () => {
    for (const variable of ['--font-headline', '--font-body', '--font-accent', '--font-code']) {
      const line = GLOBALS.split('\n').find((l) => l.includes(`${variable}:`));
      expect(line).toBeDefined();
      expect(line as string).toContain('Noto Nastaliq Urdu');
    }
    expect(GLOBALS).toContain('--font-urdu:');
    expect(GLOBALS).toContain('--font-unicode:');
  });

  test('global CSS defines urdu, unicode and RTL font utilities', () => {
    expect(GLOBALS).toMatch(/\.font-urdu\s*\{/);
    expect(GLOBALS).toMatch(/\.font-unicode\s*\{/);
    expect(GLOBALS).toContain('[lang="ur"]');
    expect(GLOBALS).toContain('[dir="rtl"]');
  });

  test('tailwind exposes urdu and unicode font families', () => {
    expect(TAILWIND).toMatch(/urdu:\s*\[/);
    expect(TAILWIND).toMatch(/unicode:\s*\[/);
    expect(TAILWIND).toContain('var(--font-noto-nastaliq)');
    expect(TAILWIND).toContain('var(--font-noto-sans)');
  });
});

describe('WS7 AI assistant backend', () => {
  test('the assistant route exists and proxies through the server key pool', () => {
    expect(ASSISTANT_ROUTE).toContain('executeWithFailover');
    expect(ASSISTANT_ROUTE).toContain("@/lib/ai/key-manager");
  });

  test('the assistant route hardcodes no Gemini key and never returns one', () => {
    expect(ASSISTANT_ROUTE).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
    expect(ASSISTANT_ROUTE).not.toMatch(/GEMINI_API_KEY\s*=\s*['"]/);
    // The user supplied key may only flow into executeWithFailover and the
    // scrubber; the success payload contains reply and model only.
    const successPayload = ASSISTANT_ROUTE.slice(
      ASSISTANT_ROUTE.indexOf('success: true')
    );
    expect(successPayload.slice(0, 200)).not.toContain('apiKey');
  });

  test('the assistant route supports message, topic and a user key fallback', () => {
    expect(ASSISTANT_ROUTE).toContain('body.topic');
    expect(ASSISTANT_ROUTE).toContain('body.message');
    expect(ASSISTANT_ROUTE).toContain('body.apiKey');
  });

  test('the study assistant component posts to the server endpoint', () => {
    expect(STUDY_SECTION).toContain('/api/ai/assistant');
    expect(STUDY_SECTION).toContain("method: 'POST'");
  });

  test('the study assistant no longer gates on a client-side Gemini key', () => {
    expect(STUDY_SECTION).not.toContain('set up a Gemini API key');
    expect(STUDY_SECTION).not.toContain('configure the client-side AI integration');
    expect(STUDY_SECTION).not.toContain('AI Features Coming Soon');
  });

  test('the study assistant topic input and submit button are enabled', () => {
    const inputBlock = STUDY_SECTION.slice(STUDY_SECTION.indexOf('<Input'));
    expect(inputBlock.slice(0, 600)).not.toContain('disabled');
  });
});
