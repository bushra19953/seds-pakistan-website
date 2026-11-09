/**
 * Unit tests for the server-side blog body renderer (src/lib/blog-markdown.ts).
 *
 * Defect history: the public post page sanitized the raw body with a
 * client-only DOMPurify pass that returned '' until hydration, so stored
 * markdown reached readers as literal "##" headings, "*...*" asterisks and
 * "[text](/path)" bracket links, and the server shell announced "No
 * content available for this blog post." These tests pin the renderer
 * that replaced it: real HTML headings/links/images, HTML bodies passing
 * through sanitized, plain text paragraph-wrapped, XSS neutralised.
 */

import {
  renderBlogBody,
  looksLikeHtmlBody,
  stripDuplicateTitleHeading,
  splitHtmlAtSection,
} from '../blog-markdown';

describe('markdown rendering', () => {
  it('renders headings, paragraphs, emphasis, lists, quotes and rules', () => {
    const { html } = renderBlogBody(
      [
        '## Section One',
        '',
        'A paragraph with **bold** and *italic* text.',
        '',
        '### Subsection',
        '',
        '- first item',
        '- second item',
        '',
        '> A quoted line.',
        '',
        '---',
        '',
        'Closing paragraph.',
      ].join('\n'),
    );
    expect(html).toContain('<h2');
    expect(html).toContain('Section One');
    expect(html).toContain('<h3');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<li>first item</li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr');
    expect(html).not.toContain('##');
    expect(html).not.toContain('**');
  });

  it('renders an inline markdown link as a real anchor', () => {
    const { html } = renderBlogBody(
      'Our [South Asia Aerospace Grand Prix](/grand-prix) masterclass series is open for enrolment.',
    );
    expect(html).toContain('<a href="/grand-prix">South Asia Aerospace Grand Prix</a>');
    expect(html).not.toContain('](/grand-prix)');
  });

  it('renders a markdown image with its alt text', () => {
    const { html } = renderBlogBody('![Tiangong station](https://example.com/station.jpg)');
    expect(html).toContain('<img');
    expect(html).toContain('src="https://example.com/station.jpg"');
    expect(html).toContain('alt="Tiangong station"');
  });

  it('paragraph-wraps plain text bodies split by blank lines', () => {
    const { html } = renderBlogBody('First plain paragraph.\n\nSecond plain paragraph.');
    expect(html).toContain('<p>First plain paragraph.</p>');
    expect(html).toContain('<p>Second plain paragraph.</p>');
  });
});

describe('HTML body compatibility', () => {
  it('passes an HTML body through sanitized, unchanged in meaning', () => {
    const body = '<p>Hello <strong>world</strong>.</p>\n<p>Second <a href="https://example.com">link</a>.</p>';
    expect(looksLikeHtmlBody(body)).toBe(true);
    const { html } = renderBlogBody(body);
    expect(html).toContain('<p>Hello <strong>world</strong>.</p>');
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  it('does not treat a markdown body with a link as HTML', () => {
    expect(looksLikeHtmlBody('Intro.\n\n## Heading\n\nSee [this](/x).')).toBe(false);
  });
});

describe('sanitisation', () => {
  it('neutralises script, event handlers and javascript: URLs in HTML bodies', () => {
    const body =
      '<p onclick="steal()">hi</p><script>alert(1)</script>' +
      '<img src="x" onerror="alert(1)">' +
      '<p><a href="javascript:alert(1)">click</a></p>';
    const { html } = renderBlogBody(body);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('hi');
  });

  it('neutralises markup injected into a markdown body', () => {
    const { html } = renderBlogBody('Hello <script>alert(1)</script> **world**');
    expect(html).not.toContain('<script');
    expect(html).toContain('<strong>world</strong>');
  });
});

describe('duplicate title heading', () => {
  it('drops a leading H1 that repeats the post title', () => {
    const body = '# A Pakistani Astronaut Will Visit China’s Space Station\n\nPakistan is about to have an astronaut in orbit.';
    const { html } = renderBlogBody(body, {
      title: "A Pakistani Astronaut Will Visit China's Space Station",
    });
    expect(html).not.toContain('<h1');
    expect(html).toContain('astronaut in orbit');
  });

  it('keeps a leading H1 that is not the post title', () => {
    const out = stripDuplicateTitleHeading('# A Different Heading\n\nText.', 'Some Other Title');
    expect(out).toContain('# A Different Heading');
  });
});

describe('empty bodies', () => {
  it('returns empty output for missing bodies', () => {
    for (const body of ['', '   ', null, undefined]) {
      const r = renderBlogBody(body as string | null | undefined);
      expect(r.html).toBe('');
      expect(r.wordCount).toBe(0);
      expect(r.readingMinutes).toBe(0);
    }
  });
});

describe('mid-article split', () => {
  const longBody = [
    '## Alpha',
    '',
    'alpha '.repeat(90),
    '',
    '## Bravo',
    '',
    'bravo '.repeat(90),
    '',
    '## Charlie',
    '',
    'charlie '.repeat(90),
    '',
    '## Delta',
    '',
    'delta '.repeat(90),
  ].join('\n');

  it('splits a long sectioned article near the middle', () => {
    const { html, leadHtml, restHtml } = renderBlogBody(longBody);
    expect(restHtml).not.toBeNull();
    expect(leadHtml.length).toBeGreaterThan(0);
    expect((leadHtml + restHtml).replace(/\s/g, '')).toBe(html.replace(/\s/g, ''));
    expect(restHtml!.startsWith('<h2')).toBe(true);
  });

  it('does not split a short article', () => {
    const { restHtml } = renderBlogBody('## Only\n\nShort body.');
    expect(restHtml).toBeNull();
    const direct = splitHtmlAtSection('<p>tiny</p>');
    expect(direct.restHtml).toBeNull();
  });

  it('reports word count and a sane reading time', () => {
    const r = renderBlogBody(longBody);
    expect(r.wordCount).toBeGreaterThan(350);
    expect(r.readingMinutes).toBeGreaterThanOrEqual(2);
  });
});
