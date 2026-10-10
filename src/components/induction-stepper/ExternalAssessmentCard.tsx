"use client";

import { useFormContext } from 'react-hook-form';
import { ExternalLink } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const URL_RE = /(https?:\/\/[^\s]+)/g;
// Hostnames that belong to this site. Links to them are rendered as normal
// inline links; only truly off-site URLs get the external-step treatment.
const OWN_HOSTS = new Set([
  'sedspakistan.live',
  'seds-pakistan.vercel.app',
  'v0-seds-pakistan.vercel.app',
]);

function isExternalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (OWN_HOSTS.has(host)) return false;
    if (typeof window !== 'undefined') {
      const here = window.location.hostname.replace(/^www\./, '').toLowerCase();
      if (host === here) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Split a description into text parts and cleaned URLs. Trailing punctuation
 * (a sentence-final period, comma, closing bracket, ...) is almost never part
 * of the URL, so it is stripped from the link target while the raw text keeps
 * its original rendering.
 */
export function splitDescriptionLinks(description: string): Array<{ text: string } | { url: string }> {
  if (typeof description !== 'string') return [{ text: '' }];
  URL_RE.lastIndex = 0;
  const out: Array<{ text: string } | { url: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(description)) !== null) {
    if (m.index > last) out.push({ text: description.slice(last, m.index) });
    const raw = m[0];
    const cleaned = raw.replace(/[.,;:!?)\]}]+$/, '');
    const trailing = raw.slice(cleaned.length);
    out.push({ url: cleaned });
    if (trailing) out.push({ text: trailing });
    last = m.index + raw.length;
  }
  if (last < description.length) out.push({ text: description.slice(last) });
  return out;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** True when the field description links off-site (e.g. a third-party test). */
export function hasExternalAssessmentLink(field: any): boolean {
  if (!field || typeof field.description !== 'string' || !field.description.includes('http')) {
    return false;
  }
  return splitDescriptionLinks(field.description).some(
    (part) => 'url' in part && isExternalUrl(part.url)
  );
}

/** Companion form key that carries the pasted-back result for an external step. */
export function assessmentResultKey(fieldName: string): string {
  return `${fieldName}Result`;
}

/**
 * Renders an admin-configured field whose description points off-site (for
 * example a third-party personality test) as an explicit external step:
 *
 * - the link is clearly labeled with its destination and opens in a new tab,
 *   so the applicant is never yanked out of the funnel;
 * - copy reassures them the application is auto-saved and stays open here;
 * - an optional result input writes back into the application document as
 *   `<fieldName>Result`, so the outcome returns to the platform instead of
 *   being lost on the third-party site.
 */
export default function ExternalAssessmentCard({ field }: { field: any }) {
  const { register } = useFormContext();
  const resultName = assessmentResultKey(field?.name ?? 'external');
  const parts = splitDescriptionLinks(field?.description ?? '');

  return (
    <div className="mt-1 mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        External step &mdash; opens in a new tab
      </p>

      <p className="text-sm text-muted-foreground">
        {parts.map((part, i) =>
          'url' in part ? (
            <a
              key={i}
              href={part.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-blue-500 underline decoration-dotted underline-offset-2 hover:text-blue-400"
            >
              {isExternalUrl(part.url)
                ? `Take the test on ${hostnameOf(part.url)} (opens in a new tab)`
                : part.url}
            </a>
          ) : (
            <span key={i}>{part.text}</span>
          )
        )}
      </p>

      <p className="mt-2 text-xs text-muted-foreground">
        Your application is auto-saved and stays open here. Come back and press
        &ldquo;Next Step&rdquo; when you&rsquo;re done.
      </p>

      <div className="mt-3">
        <Label htmlFor={resultName} className="text-sm font-medium">
          Your result <span className="font-normal text-muted-foreground">(optional &mdash; paste it here so it lands in your application)</span>
        </Label>
        <Input
          id={resultName}
          {...register(resultName)}
          placeholder="e.g. paste your result code here"
          className="mt-1"
        />
      </div>
    </div>
  );
}
