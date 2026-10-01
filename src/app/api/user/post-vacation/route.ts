import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        return NextResponse.json({
            status: 'ok',
            message: 'Post-vacation status logged',
            acknowledged: true
        });
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
}

export async function GET(req: NextRequest) {
    return NextResponse.json({ status: 'ok', message: 'Post-vacation endpoint active' });
}
