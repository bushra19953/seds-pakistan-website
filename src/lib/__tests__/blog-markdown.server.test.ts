/**
 * @jest-environment node
 *
 * Server-environment coverage for src/lib/blog-markdown.ts: with no
 * browser window present, the sanitizer must bind DOMPurify to a jsdom
 * window and still neutralise XSS. This is the code path the public post
 * page exercises during SSR.
 */

import { renderBlogBody, sanitizeBlogHtml } from '../blog-markdown';

describe('server-side rendering (no window)', () => {
  it('renders markdown to sanitized HTML', () => {
    const { html } = renderBlogBody('## Heading\n\nBody with [a link](/grand-prix).');
    expect(html).toContain('<h2');
    expect(html).toContain('<a href="/grand-prix">a link</a>');
    expect(html).not.toContain('##');
  });

  it('strips scripts and handlers without a browser window', () => {
    const out = sanitizeBlogHtml(
      '<p onclick="x()">ok</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a>',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('ok');
  });
});
