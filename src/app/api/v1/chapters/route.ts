import { NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { getAdminDiagnostics } from '@/lib/server/firebase-admin';
import {
  resolveChaptersSupaAdapter,
  listChaptersViaSupa,
} from '@/lib/chapters-supa';
import { getChaptersSnapshot } from '@/lib/server/chapters-cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    console.log('[chapters:route] HANDLER_START: Chapters GET handler initiated');
    // Ensure Admin SDK is initialized per request and acquire Firestore lazily
    const initOk = ensureAdminInitialized();
    console.log('[chapters:route] DIAGNOSTIC: ensureAdminInitialized called. initOk =', initOk);
    if (!initOk) {
      console.error('[chapters:route] Admin init failed', getAdminDiagnostics());
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }
    const db = getDb();
    console.log('[chapters:route] DIAGNOSTIC: getDb() called. Is db null?', db === null, 'type:', typeof db);
    if (!db) {
      console.error('[chapters:route] Firestore not available', getAdminDiagnostics());
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }
    console.log('[chapters:route] DIAGNOSTIC: Fetching collection "chapters"');
    const shapeChapter = (id: string, data: any) => ({
      id,
      name: data?.name || data?.slug || id,
      slug: data?.slug || null,
      city: data?.city || null,
      country: data?.country || null,
      logoUrl: data?.logoUrl || null,
      isActive: data?.isActive ?? true,
    });
    // Supa seam (flag ON only): serve the list from fs_chapters. Any
    // seam error falls back to the Firestore read below, unchanged.
    // Flag OFF -> adapter is null and this block is skipped entirely.
    const supa = await resolveChaptersSupaAdapter();
    if (supa) {
      try {
        const docs = await listChaptersViaSupa(supa);
        const chapters = docs
          .map((d) => shapeChapter(String(d.id), d))
          .sort((a, b) => a.name.localeCompare(b.name));
        console.log('[chapters:route] SUCCESS: Returning chapters payload (supa)', { count: chapters.length });
        return NextResponse.json({ chapters });
      } catch (err) {
        console.error('[chapters:route] supa list failed; falling back to Firestore', err);
      }
    }
    // Cached snapshot (perf program, 2026-10-30): the chapters list
    // changes only through consent-gated lifecycle acts, so the
    // Firestore fallback reads through the 5-minute chapters cache
    // instead of re-billing the collection on every request.
    const rows = await getChaptersSnapshot(db);
    const chapters = rows.map((row) => shapeChapter(row.id, row.data)).sort((a, b) => a.name.localeCompare(b.name));
    console.log('[chapters:route] SUCCESS: Returning chapters payload', { count: chapters.length });
    return NextResponse.json({ chapters });
  } catch (e: any) {
    console.error('HANDLER_ERROR: [chapters:route] Exception in GET handler', e);
    console.error('API_CRASH_DETAILS: [chapters:route] GET error', { message: e?.message, stack: e?.stack });
    return NextResponse.json({ error: e?.message || 'Failed to load chapters' }, { status: 500 });
  }
}
