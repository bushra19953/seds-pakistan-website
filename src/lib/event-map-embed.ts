/**
 * Safe resolution of an event's stored `mapUrl` for the public
 * detail page (EV-P35).
 *
 * The stored value used to be injected with dangerouslySetInnerHTML
 * whenever it contained "<iframe", so anyone who gained an events
 * write could place arbitrary markup on a public event page. The
 * codebase's rich-HTML sanitizer (DOMPurify with default config,
 * used for the event description and the blog body) cannot be reused
 * for this: its defaults strip <iframe> entirely, which would break
 * the legitimate Google Maps embeds this field exists to carry.
 *
 * Instead, the stored value is REDUCED to data we render ourselves:
 * - 'embed' — an iframe src on an allowlisted Google Maps host.
 *   When the stored value is pasted embed HTML, only the iframe's
 *   src attribute is extracted; every other tag and attribute in
 *   the stored string is discarded. The page renders its own
 *   <iframe> element with that src and nothing else.
 * - 'link' — a plain http(s) URL that is not an embeddable map;
 *   the page keeps its previous "View on Map" external-link card.
 * - null — nothing renderable (empty, unparseable, or a non-http
 *   scheme such as javascript:).
 */

export type MapEmbedResolution =
    | { kind: 'embed'; src: string }
    | { kind: 'link'; href: string }
    | null;

/**
 * Hosts whose /maps URLs may be iframed. Mirrors the only host the
 * page ever embedded before this fix (its non-HTML branch keyed on
 * 'google.com/maps'); parsed-URL matching also closes the old
 * substring check's look-alike-host hole.
 */
const MAP_EMBED_HOSTS = new Set(['www.google.com', 'google.com', 'maps.google.com']);

function isAllowlistedMapUrl(url: URL): boolean {
    return (
        url.protocol === 'https:' &&
        MAP_EMBED_HOSTS.has(url.hostname) &&
        url.pathname.startsWith('/maps')
    );
}

function extractIframeSrc(html: string): string | null {
    const match = html.match(/<iframe\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!match) return null;
    return (match[1] ?? match[2] ?? '').trim() || null;
}

export function resolveMapEmbed(raw: unknown): MapEmbedResolution {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;

    let candidate = value;
    if (/<iframe/i.test(value)) {
        const src = extractIframeSrc(value);
        if (!src) return null;
        candidate = src;
    }

    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        return null;
    }

    if (isAllowlistedMapUrl(url)) {
        return { kind: 'embed', src: url.toString() };
    }
    if (url.protocol === 'https:' || url.protocol === 'http:') {
        return { kind: 'link', href: url.toString() };
    }
    return null;
}
