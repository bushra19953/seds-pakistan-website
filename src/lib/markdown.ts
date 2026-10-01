import DOMPurify from 'dompurify';
import { marked } from 'marked';

// Convert Markdown (or raw HTML) to sanitized HTML suitable for rendering.
// - Supports GitHub-flavored markdown and line breaks.
// - Normalizes common paste artifacts in href/src attributes.
export function renderMarkdownSafe(input: string | null | undefined): string {
  if (!input || typeof input !== 'string') return '';

  // Convert markdown to HTML
  const html = marked.parse(input, { gfm: true, breaks: true });

  // Normalize URLs inside attributes to strip stray backticks/newlines
  const normalized = String(html).replace(
    /(href|src)\s*=\s*(['"])((?:.|\n)*?)\2/gi,
    (_m, attr, quote, val) => {
      const cleaned = String(val).replace(/[`]/g, '').trim();
      return `${attr}=${quote}${cleaned}${quote}`;
    }
  );

  // Sanitize final HTML output to prevent XSS
  try {
    return DOMPurify.sanitize(normalized);
  } catch {
    // Fallback: minimal escaping if DOMPurify fails unexpectedly
    return normalized.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}


// Strip markdown syntax to return plain text for previews/summaries
export function stripMarkdown(input: string | null | undefined): string {
  if (!input || typeof input !== 'string') return '';
  // Remove headers
  let text = input.replace(/^#+\s+/gm, '');
  // Remove bold/italic
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  // Remove links [text](url) -> text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove images ![alt](url) -> alt
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  // Remove blockquotes
  text = text.replace(/^\s*>\s+/gm, '');
  // Remove lists
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  // Remove HTML tags
  text = text.replace(/<[^>]*>/g, '');

  return text.trim();
}
