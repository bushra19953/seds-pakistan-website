/**
 * Server-side blog body rendering.
 *
 * Blog bodies are written in the admin as markdown (or, for older posts,
 * raw HTML or plain text). The public post page used to drop the raw body
 * into a client-only DOMPurify pass that returned '' until hydration, so
 * readers and crawlers saw literal "##" markers, "[text](/path)" bracket
 * links and "No content available for this blog post." This module renders
 * the body to sanitized HTML on the server instead:
 *
 * - Markdown bodies -> HTML via the subset renderer below.
 * - HTML bodies -> passed through the sanitizer unchanged in meaning.
 * - Plain-text bodies -> paragraph-wrapped.
 *
 * Why a subset renderer instead of the project's `marked` dependency:
 * marked v16 is ESM-only, and this repo's jest config cannot load ESM
 * packages from node_modules, so a marked-based renderer is untestable
 * here (the marked-based src/lib/markdown.ts survives only because no
 * test imports it). Blog bodies are simple prose, so this module renders
 * the subset they use — headings, paragraphs, bold, italic, inline code,
 * code fences, links, images, lists, blockquotes, rules — and relies on
 * the sanitizer, not the parser, for safety.
 *
 * Sanitisation is DOMPurify-grade: DOMPurify itself, bound to a jsdom
 * window on the server (the same pairing isomorphic-dompurify uses) and
 * to the real window if this ever runs in a browser. If no DOM is
 * available at all, the fallback escapes every tag rather than emitting
 * unsanitized markup.
 */
import createDOMPurify from 'dompurify';

type Purifier = ReturnType<typeof createDOMPurify>;

let purifier: Purifier | null = null;
let purifierUnavailable = false;

function getPurifier(): Purifier | null {
  if (purifier || purifierUnavailable) return purifier;
  try {
    if (typeof window !== 'undefined') {
      purifier = createDOMPurify(window as unknown as any);
    } else {
      // Server: DOMPurify needs a DOM. jsdom is already in the dependency
      // tree (jest environment), so bind to a throwaway jsdom window
      // exactly like isomorphic-dompurify does.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { JSDOM } = require('jsdom');
      purifier = createDOMPurify(new JSDOM('').window as unknown as any);
    }
    if (!purifier || !(purifier as unknown as { isSupported?: boolean }).isSupported) {
      purifier = null;
      purifierUnavailable = true;
    }
  } catch {
    purifier = null;
    purifierUnavailable = true;
  }
  return purifier;
}

/** Sanitize a block of HTML. Never returns unsanitized markup. */
export function sanitizeBlogHtml(html: string): string {
  if (!html) return '';
  const instance = getPurifier();
  if (instance) return instance.sanitize(html);
  // No DOM available: escape everything. Ugly but safe — this path should
  // never be reached in the Next server runtime where jsdom resolves.
  return html.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ------------------------------------------------------------------ */
/* Markdown subset renderer                                            */
/* ------------------------------------------------------------------ */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;

/**
 * Render inline markdown (emphasis, code, links, images) for one text
 * run. Raw HTML in the run is escaped here; block-level HTML bodies never
 * reach this function (they take the sanitize-only path), and the final
 * output is DOMPurify-sanitized regardless.
 */
function renderInline(text: string): string {
  const stash: string[] = [];
  const keep = (html: string): string => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };

  let out = text;

  // Inline code first: its content is literal.
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    keep(`<code>${escapeHtml(code)}</code>`),
  );

  // Images, then links (link text may carry emphasis, so render it
  // through the emphasis pass before stashing the finished anchor).
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt: string, src: string, title?: string) =>
    keep(
      `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${
        title ? ` title="${escapeHtml(title)}"` : ''
      } loading="lazy" decoding="async">`,
    ),
  );
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, label: string, href: string, title?: string) =>
    keep(
      `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${renderEmphasis(
        escapeHtml(label),
      )}</a>`,
    ),
  );

  out = escapeHtml(out);
  out = renderEmphasis(out);

  return out.replace(PLACEHOLDER_RE, (_m, i: string) => stash[Number(i)] ?? '');
}

/** Bold/italic on already-escaped text. */
function renderEmphasis(escaped: string): string {
  let out = escaped;
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // Underscore italic only at word boundaries, so snake_case survives.
  out = out.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  return out;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const UL_ITEM_RE = /^\s{0,3}[-*+]\s+(.+)$/;
const OL_ITEM_RE = /^\s{0,3}\d{1,9}[.)]\s+(.+)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const FENCE_RE = /^\s{0,3}```/;
const HTML_BLOCK_RE = /^\s{0,3}<\/?(p|div|h[1-6]|ul|ol|li|blockquote|figure|figcaption|table|thead|tbody|tr|td|th|section|article|header|footer|pre|hr|img)\b/i;

/** Render the markdown subset to (not yet sanitized) HTML. */
export function renderMarkdownSubset(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let i = 0;

  const isBlockStart = (line: string): boolean =>
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    UL_ITEM_RE.test(line) ||
    OL_ITEM_RE.test(line) ||
    QUOTE_RE.test(line) ||
    FENCE_RE.test(line) ||
    HTML_BLOCK_RE.test(line);

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code block.
    if (FENCE_RE.test(line)) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading.
    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (HR_RE.test(line)) {
      blocks.push('<hr>');
      i += 1;
      continue;
    }

    // Blockquote: consecutive quoted lines become paragraphs inside.
    if (QUOTE_RE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const q = lines[i].match(QUOTE_RE);
        if (!q) break;
        quoted.push(q[1]);
        i += 1;
      }
      const paras = quoted
        .join('\n')
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${renderInline(p.replace(/\n/g, ' '))}</p>`)
        .join('');
      blocks.push(`<blockquote>${paras}</blockquote>`);
      continue;
    }

    // Lists (flat; consecutive items of the same kind).
    if (UL_ITEM_RE.test(line) || OL_ITEM_RE.test(line)) {
      const ordered = OL_ITEM_RE.test(line);
      const itemRe = ordered ? OL_ITEM_RE : UL_ITEM_RE;
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i].match(itemRe);
        if (!item) break;
        items.push(`<li>${renderInline(item[1].trim())}</li>`);
        i += 1;
      }
      blocks.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    // Raw HTML block: pass through until a blank line; the sanitizer
    // downstream is the safety boundary for these.
    if (HTML_BLOCK_RE.test(line)) {
      const raw: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        raw.push(lines[i]);
        i += 1;
      }
      blocks.push(raw.join('\n'));
      continue;
    }

    // Paragraph: accumulate until a blank line or another block start.
    const para: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  return blocks.join('\n');
}

/* ------------------------------------------------------------------ */
/* Body classification + public API                                    */
/* ------------------------------------------------------------------ */

const BLOCK_HTML_RE =
  /<\/?(p|div|h[1-6]|ul|ol|li|blockquote|figure|figcaption|table|thead|tbody|tr|td|th|section|article|header|footer|pre|hr|img)\b[^>]*>/i;
const MARKDOWN_BLOCK_RE = /(^|\n)\s{0,3}(#{1,6}\s|>\s|[-*+]\s|\d{1,3}\.\s|```)/;
const MARKDOWN_LINK_RE = /\[[^\]]+\]\([^)]+\)/;

/**
 * True when the body is already HTML (sanitize only). A body with markdown
 * block structure or markdown links is treated as markdown even if it
 * contains some inline HTML.
 */
export function looksLikeHtmlBody(body: string): boolean {
  if (!BLOCK_HTML_RE.test(body)) return false;
  if (MARKDOWN_BLOCK_RE.test(body) || MARKDOWN_LINK_RE.test(body)) return false;
  return true;
}

function normalizeHeadingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

/**
 * Admin-created posts often paste the post title as a leading `# H1`,
 * which duplicates the page's own title heading. Drop that first line
 * when it matches the post title (after punctuation-insensitive
 * normalisation, so "China's" matches "China’s").
 */
export function stripDuplicateTitleHeading(markdown: string, title?: string): string {
  if (!title) return markdown;
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i >= lines.length) return markdown;
  const match = lines[i].match(/^#\s+(.+?)\s*#*\s*$/);
  if (match && normalizeHeadingText(match[1]) === normalizeHeadingText(title)) {
    lines.splice(i, 1);
    return lines.join('\n');
  }
  return markdown;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countHtmlWords(html: string): number {
  const text = stripTags(html);
  if (!text) return 0;
  return text.split(' ').filter(Boolean).length;
}

/**
 * Split rendered article HTML into a lead and a remainder at a section
 * boundary near the middle of the article (used to place one mid-article
 * ad between sections). Prefers an <h2> boundary; falls back to a
 * paragraph boundary. Returns restHtml: null when no good split exists.
 */
export function splitHtmlAtSection(
  html: string,
): { leadHtml: string; restHtml: string | null } {
  if (!html) return { leadHtml: '', restHtml: null };
  const totalWords = countHtmlWords(html);
  if (totalWords < 220) return { leadHtml: html, restHtml: null };

  const candidates: Array<{ index: number; wordsBefore: number }> = [];
  const tagRe = /<h2\b[^>]*>|<\/p>/gi;
  let match: RegExpExecArray | null;
  let cursor = 0;
  let wordsBefore = 0;
  while ((match = tagRe.exec(html)) !== null) {
    wordsBefore += countHtmlWords(html.slice(cursor, match.index));
    cursor = match.index;
    if (match[0].startsWith('<h2')) {
      candidates.push({ index: match.index, wordsBefore });
    } else {
      candidates.push({ index: match.index + match[0].length, wordsBefore });
    }
  }
  if (candidates.length === 0) return { leadHtml: html, restHtml: null };

  // Only split at an <h2> when one sits in the middle band; paragraph
  // boundaries anywhere in the band are the fallback.
  const inBand = (w: number) => w >= totalWords * 0.25 && w <= totalWords * 0.8;
  const h2Indexes = new Set(
    [...html.matchAll(/<h2\b[^>]*>/gi)].map((m) => m.index ?? -1),
  );
  const h2Candidates = candidates.filter(
    (c) => h2Indexes.has(c.index) && inBand(c.wordsBefore),
  );
  const pool = h2Candidates.length > 0 ? h2Candidates : candidates.filter((c) => inBand(c.wordsBefore));
  if (pool.length === 0) return { leadHtml: html, restHtml: null };

  const target = totalWords / 2;
  const best = pool.reduce((a, b) =>
    Math.abs(b.wordsBefore - target) < Math.abs(a.wordsBefore - target) ? b : a,
  );
  const leadHtml = html.slice(0, best.index).trim();
  const restHtml = html.slice(best.index).trim();
  if (!leadHtml || !restHtml) return { leadHtml: html, restHtml: null };
  return { leadHtml, restHtml };
}

/**
 * Body images load lazily with async decoding so a long article never
 * blocks on its figures. Applies to both render paths (the markdown
 * renderer already emits the attributes; this covers raw-HTML bodies).
 */
export function withLazyImages(html: string): string {
  return html
    .replace(/<img\b(?![^>]*\bloading=)/gi, '<img loading="lazy" decoding="async"')
    .replace(/<img\b(?=[^>]*\bloading=)(?![^>]*\bdecoding=)/gi, '<img decoding="async"');
}

export interface RenderedBlogBody {
  /** Full sanitized article HTML. */
  html: string;
  /** Lead portion up to the mid-article split (equals html when unsplit). */
  leadHtml: string;
  /** Remainder after the mid-article split, or null when unsplit. */
  restHtml: string | null;
  wordCount: number;
  /** Whole minutes to read, at 200 wpm, minimum 1 for a non-empty body. */
  readingMinutes: number;
}

/**
 * Render a stored blog body (markdown, HTML or plain text) to sanitized
 * HTML. Safe to call on the server; returns empty strings for an empty
 * body so the page can distinguish "no body" from "body rendered".
 */
export function renderBlogBody(
  body: string | null | undefined,
  opts?: { title?: string },
): RenderedBlogBody {
  const raw = typeof body === 'string' ? body.trim() : '';
  if (!raw) {
    return { html: '', leadHtml: '', restHtml: null, wordCount: 0, readingMinutes: 0 };
  }

  const html = withLazyImages(
    looksLikeHtmlBody(raw)
      ? sanitizeBlogHtml(raw)
      : sanitizeBlogHtml(renderMarkdownSubset(stripDuplicateTitleHeading(raw, opts?.title))),
  );

  const wordCount = countHtmlWords(html);
  const { leadHtml, restHtml } = splitHtmlAtSection(html);
  return {
    html,
    leadHtml,
    restHtml,
    wordCount,
    readingMinutes: wordCount > 0 ? Math.max(1, Math.ceil(wordCount / 200)) : 0,
  };
}
