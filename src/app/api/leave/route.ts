import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    return NextResponse.json({ status: 'ok', message: 'Leave endpoint active' });
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => ({}));
        return NextResponse.json({ status: 'ok', received: true });
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
}
