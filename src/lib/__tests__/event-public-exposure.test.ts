/**
 * EV-P32 / EV-P33 / EV-P35 regression pins (events public exposure).
 *
 * - EV-P33: GET /api/events/upcoming was an orphaned, unauthenticated
 *   endpoint returning the 3 newest events with no status filter
 *   (drafts and full raw descriptions included). Grep-verified zero
 *   consumers in src/, public/, functions/, scripts/ (HomepageEventFeed
 *   reads Firestore directly), so the route is deleted, not filtered.
 * - EV-P32: the public event detail page hid unpublished/deleted
 *   events but never checked `visibility`, so a published
 *   members-only or private event rendered in full for anyone with
 *   the address. canViewEventOnPublicPage is the guard the page (and
 *   the OG-metadata data path) now enforce.
 * - EV-P35: the location map embed was injected as raw unsanitized
 *   HTML (dangerouslySetInnerHTML on the stored mapUrl). The stored
 *   value now goes through resolveMapEmbed, which returns only a
 *   validated iframe src on an allowlisted Google Maps host (or a
 *   plain external link); no stored markup is ever passed through.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { canViewEventOnPublicPage, isPubliclyExposableEvent } from '@/lib/event-access';
import { resolveMapEmbed } from '@/lib/event-map-embed';

const repoRoot = process.cwd();

const ANON = { uid: null, isEventsAdmin: false };
const MEMBER = { uid: 'member-uid-1', isEventsAdmin: false };
const AUTHOR = { uid: 'author-uid-1', isEventsAdmin: false };
const ADMIN = { uid: 'admin-uid-1', isEventsAdmin: true };

const publishedPublic = {
    status: 'published',
    visibility: 'public',
    createdByUid: 'author-uid-1',
};

describe('EV-P33: the orphaned upcoming route is gone', () => {
    it('src/app/api/events/upcoming/route.ts does not exist', () => {
        expect(existsSync(join(repoRoot, 'src/app/api/events/upcoming/route.ts'))).toBe(false);
    });

    it('no source file references the deleted endpoint', () => {
        const client = readFileSync(join(repoRoot, 'src/app/events/[slug]/_event-client.tsx'), 'utf8');
        expect(client).not.toContain('events/upcoming');
    });
});

describe('EV-P32: visibility is enforced on the public detail page', () => {
    it('a public published event renders for an anonymous visitor', () => {
        expect(canViewEventOnPublicPage(publishedPublic, ANON)).toBe(true);
    });

    it('a published event with no visibility field renders for an anonymous visitor (form default is public)', () => {
        const { visibility: _v, ...noVisibility } = publishedPublic;
        expect(canViewEventOnPublicPage(noVisibility, ANON)).toBe(true);
    });

    it('a members-only published event does NOT render for an anonymous visitor', () => {
        expect(canViewEventOnPublicPage({ ...publishedPublic, visibility: 'members' }, ANON)).toBe(false);
    });

    it('a members-only published event renders for a signed-in member', () => {
        expect(canViewEventOnPublicPage({ ...publishedPublic, visibility: 'members' }, MEMBER)).toBe(true);
    });

    it('a private published event does NOT render for a signed-in non-author', () => {
        expect(canViewEventOnPublicPage({ ...publishedPublic, visibility: 'private' }, MEMBER)).toBe(false);
    });

    it('a private published event renders for its author', () => {
        expect(canViewEventOnPublicPage({ ...publishedPublic, visibility: 'private' }, AUTHOR)).toBe(true);
    });

    it('a private published event renders for an events admin', () => {
        expect(canViewEventOnPublicPage({ ...publishedPublic, visibility: 'private' }, ADMIN)).toBe(true);
    });

    it('a private event matches the author via the legacy createdBy field', () => {
        const legacy = { status: 'published', visibility: 'private', createdBy: 'author-uid-1' };
        expect(canViewEventOnPublicPage(legacy, AUTHOR)).toBe(true);
        expect(canViewEventOnPublicPage(legacy, MEMBER)).toBe(false);
    });

    it('unpublished and deleted events stay hidden regardless of visibility or viewer', () => {
        expect(canViewEventOnPublicPage({ ...publishedPublic, status: 'draft' }, ADMIN)).toBe(false);
        expect(canViewEventOnPublicPage({ ...publishedPublic, deleted: true }, ANON)).toBe(false);
        expect(canViewEventOnPublicPage({ ...publishedPublic, status: 'archived', visibility: 'members' }, MEMBER)).toBe(false);
        expect(canViewEventOnPublicPage(null, ANON)).toBe(false);
        expect(canViewEventOnPublicPage(undefined, ANON)).toBe(false);
    });

    it('the legacy published:true flag still counts as published', () => {
        expect(canViewEventOnPublicPage({ published: true, visibility: 'members' }, MEMBER)).toBe(true);
        expect(canViewEventOnPublicPage({ published: true, visibility: 'members' }, ANON)).toBe(false);
    });
});

describe('EV-P32: OG metadata exposure uses the anonymous-public test', () => {
    it('only public, published, non-deleted events are exposable', () => {
        expect(isPubliclyExposableEvent(publishedPublic)).toBe(true);
        expect(isPubliclyExposableEvent({ ...publishedPublic, visibility: 'members' })).toBe(false);
        expect(isPubliclyExposableEvent({ ...publishedPublic, visibility: 'private' })).toBe(false);
        expect(isPubliclyExposableEvent({ ...publishedPublic, deleted: true })).toBe(false);
        expect(isPubliclyExposableEvent({ ...publishedPublic, status: 'draft' })).toBe(false);
    });
});

describe('EV-P35: the map embed can no longer inject arbitrary markup', () => {
    it('a stored Google Maps embed iframe resolves to its validated src only', () => {
        const stored = '<iframe src="https://www.google.com/maps/embed?pb=!1m18!1m12" width="600" height="450" style="border:0" allowfullscreen loading="lazy"></iframe>';
        expect(resolveMapEmbed(stored)).toEqual({
            kind: 'embed',
            src: 'https://www.google.com/maps/embed?pb=!1m18!1m12',
        });
    });

    it('a script-bearing fixture is neutralised: only the allowlisted src survives', () => {
        const stored = '<iframe src="https://www.google.com/maps?q=IST+Islamabad&output=embed" onload="alert(1)"></iframe><script>alert("xss")</script>';
        const resolved = resolveMapEmbed(stored);
        expect(resolved).toEqual({
            kind: 'embed',
            src: 'https://www.google.com/maps?q=IST+Islamabad&output=embed',
        });
        expect(JSON.stringify(resolved)).not.toContain('script');
        expect(JSON.stringify(resolved)).not.toContain('onload');
        expect(JSON.stringify(resolved)).not.toContain('alert');
    });

    it('an iframe whose src is not an allowlisted map host never becomes an embed', () => {
        const stored = '<iframe src="https://evil.example.com/phish"></iframe><script>alert(1)</script>';
        const resolved = resolveMapEmbed(stored);
        expect(resolved?.kind).not.toBe('embed');
        expect(JSON.stringify(resolved)).not.toContain('<');
    });

    it('a javascript: payload resolves to nothing renderable', () => {
        expect(resolveMapEmbed('<iframe src="javascript:alert(1)"></iframe>')).toBeNull();
        expect(resolveMapEmbed('javascript:alert(1)')).toBeNull();
    });

    it('a plain Google Maps URL still embeds, as before', () => {
        expect(resolveMapEmbed('https://www.google.com/maps?q=IST+Islamabad')).toEqual({
            kind: 'embed',
            src: 'https://www.google.com/maps?q=IST+Islamabad',
        });
    });

    it('a look-alike host does not pass the allowlist', () => {
        const resolved = resolveMapEmbed('https://www.google.com.evil.example/maps?q=x');
        expect(resolved?.kind).not.toBe('embed');
    });

    it('a non-map https URL degrades to an external link, as before', () => {
        expect(resolveMapEmbed('https://maps.example.org/venue')).toEqual({
            kind: 'link',
            href: 'https://maps.example.org/venue',
        });
    });

    it('empty and non-string values resolve to null', () => {
        expect(resolveMapEmbed('')).toBeNull();
        expect(resolveMapEmbed('   ')).toBeNull();
        expect(resolveMapEmbed(undefined)).toBeNull();
        expect(resolveMapEmbed(null)).toBeNull();
    });

    it('the detail page no longer injects the stored mapUrl as raw HTML', () => {
        const client = readFileSync(join(repoRoot, 'src/app/events/[slug]/_event-client.tsx'), 'utf8');
        expect(client).not.toContain('__html: (event as any).mapUrl');
        expect(client).toContain('resolveMapEmbed');
    });
});
