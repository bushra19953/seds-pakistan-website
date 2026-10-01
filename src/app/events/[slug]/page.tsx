// ─── ENGINE 1: SERVER COMPONENT WITH DYNAMIC OPEN GRAPH METADATA ─────────────
// This file MUST remain a Server Component (no 'use client').
// All client-side logic (hooks, state, Firestore listener) lives in _event-client.tsx.
// Next.js App Router reads generateMetadata from this file at request time.

import type { Metadata, ResolvingMetadata } from 'next';
import { getDb } from '@/lib/server/firebase-admin';
import EventClientPageWrapper from './_event-client';

// ─── Helper: strip HTML tags from description ─────────────────────────────────
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')   // remove all HTML tags
    .replace(/&nbsp;/gi, ' ')  // decode common HTML entities
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')      // collapse whitespace
    .trim();
}

// ─── Helper: clean up and truncate description for social previews ─────────────
function toOgDescription(raw: string, maxLen = 155): string {
  // Strip leading punctuation: em dashes, hyphens, bullets, pipes, colons
  const cleaned = raw.replace(/^[\s\-–—|:•*>]+/, '').trim();
  if (cleaned.length <= maxLen) return cleaned;
  // Truncate at last complete word before maxLen, then append ellipsis
  const slice = cleaned.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 80 ? slice.slice(0, lastSpace) : slice) + '…';
}


// ─── generateMetadata: Server-side OG + Twitter Card tags ────────────────────
export async function generateMetadata(
  { params }: { params: Promise<{ slug: string }> },
  _parent: ResolvingMetadata
): Promise<Metadata> {
  const { slug } = await params;

  const siteName = 'SEDS Pakistan';
  const siteUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://sedspakistan.org';
  const fallbackImage = `${siteUrl}/assets/og-default.png`;
  const canonicalUrl = `${siteUrl}/events/${slug}`;

  try {
    const db = getDb();
    if (!db) throw new Error('Admin SDK unavailable');

    const snap = await db.collection('events').doc(slug).get();

    if (!snap.exists) {
      return {
        title: 'Event Not Found | SEDS Pakistan',
        description: 'This event does not exist or has been removed.',
      };
    }

    const event = snap.data() as Record<string, any>;

    // Guard: only expose published events in OG tags
    const isPublished = event.status === 'published' || event.published === true;
    if (!isPublished) {
      return { title: 'SEDS Pakistan — Events', description: siteName };
    }

    const ogTitle = event.title || siteName;
    const rawDescription = event.description ? stripHtml(event.description) : '';
    const description =
      toOgDescription(rawDescription) ||
      `Join us for ${event.title} — hosted by ${siteName}.`;
    const imageUrl = event.imageUrl || event.bannerImage || fallbackImage;

    return {
      title: `${ogTitle} | ${siteName}`,
      description,
      alternates: { canonical: canonicalUrl },
      openGraph: {
        title: ogTitle,
        description,
        url: canonicalUrl,
        siteName,
        type: 'website',
        images: [
          {
            url: imageUrl,
            width: 1200,
            height: 630,
            alt: ogTitle,
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title: ogTitle,
        description,
        images: [imageUrl],
        site: '@SEDSPakistan',
      },
    };
  } catch (_err) {
    // Graceful fallback — page still renders, just with generic meta
    return {
      title: `Event | ${siteName}`,
      description: `Check out this event on ${siteName}.`,
      openGraph: {
        title: siteName,
        images: [{ url: fallbackImage, width: 1200, height: 630, alt: siteName }],
      },
      twitter: {
        card: 'summary_large_image',
        images: [fallbackImage],
      },
    };
  }
}

// ─── Page: thin Server Component — delegates all rendering to the Client ──────
export default function EventSlugPage() {
  return <EventClientPageWrapper />;
}