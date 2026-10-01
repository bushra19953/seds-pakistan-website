import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';

export async function POST(request: NextRequest) {
  try {
    const token = request.headers.get('x-admin-token') || '';
    const secret = process.env.REVALIDATE_TOKEN || '';
    if (process.env.NODE_ENV === 'production' && (!secret || token !== secret)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = await request.json();
    const tags: string[] = Array.isArray(body?.tags) ? body.tags : [];
    for (const t of tags) revalidateTag(t);
    return NextResponse.json({ revalidated: tags });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to revalidate' }, { status: 500 });
  }
}
