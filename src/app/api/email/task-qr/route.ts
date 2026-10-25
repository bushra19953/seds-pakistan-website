/**
 * GET /api/email/task-qr?link=<url-encoded absolute task link>
 *
 * Serves the QR code PNG that notification emails embed (task_assigned
 * template in src/lib/mailer.ts). Email clients such as Gmail refuse to
 * render data: URI images, and Brevo's transactional API offers no
 * CID/inline-image support, so the QR has to be a hosted https image.
 * This route renders it on demand from the exact link the QR encodes.
 *
 * Abuse guard: only https links on the canonical domain (or on the host
 * serving this route, e.g. localhost in development) are encoded.
 * Anything else is a 400, so the endpoint cannot be used to mint QR
 * codes for third-party URLs under the SEDS domain.
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CANONICAL_HOST = 'sedspakistan.live';
const MAX_LINK_LENGTH = 2048;

export async function GET(request: NextRequest) {
    const link = new URL(request.url).searchParams.get('link');
    if (!link || link.length > MAX_LINK_LENGTH) {
        return NextResponse.json({ error: 'A valid link parameter is required' }, { status: 400 });
    }

    let parsed: URL;
    try {
        parsed = new URL(link);
    } catch {
        return NextResponse.json({ error: 'Invalid link parameter' }, { status: 400 });
    }

    const servingHost = new URL(request.url).hostname;
    const hostAllowed = parsed.hostname === CANONICAL_HOST || parsed.hostname === servingHost;
    // http is tolerated only for same-host links in local development.
    const isLocalDev = servingHost === 'localhost' || servingHost === '127.0.0.1';
    const protocolOk =
        parsed.protocol === 'https:' ||
        (isLocalDev && parsed.hostname === servingHost && parsed.protocol === 'http:');
    if (!protocolOk || !hostAllowed || parsed.username || parsed.password) {
        return NextResponse.json(
            { error: 'Link must be an https URL on sedspakistan.live' },
            { status: 400 },
        );
    }

    try {
        const QRCode = (await import('qrcode')).default;
        const png = await QRCode.toBuffer(link, {
            margin: 1,
            width: 320,
            errorCorrectionLevel: 'M',
        });
        return new NextResponse(new Uint8Array(png), {
            headers: {
                'Content-Type': 'image/png',
                // The PNG is a pure function of the link parameter.
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
        });
    } catch (e) {
        console.error('[email/task-qr] QR generation failed:', e instanceof Error ? e.message : e);
        return NextResponse.json({ error: 'QR generation failed' }, { status: 500 });
    }
}
