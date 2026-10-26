import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { readPublicSkillsViaSupa } from '@/lib/server/public-skills-supa';
import { mirrorSkillCreate } from '@/lib/server/skills-supa';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The 18 legacy skills (same source as /api/skills/migrate-legacy). If the
// skills collection is empty when this public endpoint is hit, the seed runs
// once before the read, so the public page never shows a blank list just
// because the migration endpoint was never called.
const LEGACY_SKILLS: Array<{ name: string; category: string; status: string }> = [
  { name: 'Technical Writing', category: 'General Skills', status: 'active' },
  { name: 'Programming', category: 'General Skills', status: 'active' },
  { name: 'Research Methods', category: 'General Skills', status: 'active' },
  { name: 'Teamwork', category: 'General Skills', status: 'active' },
  { name: 'PCB Design', category: 'Electronics & Embedded Systems', status: 'active' },
  { name: 'Soldering', category: 'Electronics & Embedded Systems', status: 'active' },
  { name: 'Embedded Systems', category: 'Electronics & Embedded Systems', status: 'active' },
  { name: 'Microcontroller Programming', category: 'Electronics & Embedded Systems', status: 'active' },
  { name: '3D Printing', category: 'Fabrication & Manufacturing', status: 'active' },
  { name: 'Laser Cutting', category: 'Fabrication & Manufacturing', status: 'active' },
  { name: 'Traditional Fabrication', category: 'Fabrication & Manufacturing', status: 'active' },
  { name: 'Computational Fluid Dynamics (CFD)', category: 'Aerospace Fundamentals', status: 'active' },
  { name: 'Thermodynamics', category: 'Aerospace Fundamentals', status: 'active' },
  { name: 'Orbital Mechanics', category: 'Aerospace Fundamentals', status: 'active' },
  { name: 'Propulsion Systems', category: 'Aerospace Fundamentals', status: 'active' },
  { name: 'Satellite Simulation', category: 'Software & Simulation', status: 'active' },
  { name: 'CAD Modeling', category: 'Software & Simulation', status: 'active' },
  { name: 'Signal Processing', category: 'Software & Simulation', status: 'active' },
];

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function legacySkillSeeds() {
  return LEGACY_SKILLS.map((item) => ({ ...item, slug: slugify(item.name) }));
}

// Per-instance guard: the emptiness probe runs at most once per warm server
// instance, so normal requests do not pay for a probe at all. A fresh instance
// does exactly one single-document probe. The probe is skipped entirely once
// seeding has succeeded or the collection is found non-empty.
let seedCheckDone = false;

/**
 * Idempotent seed of the legacy skills. Only writes when the collection is
 * empty. Writes use the slug as the document id, so concurrent seeds from
 * multiple instances converge on the same 18 documents instead of duplicating.
 * Never throws: a failed seed logs and the read path continues; the next
 * request retries because the guard is only set on success or non-empty.
 */
export async function ensureSkillsSeeded(db: any): Promise<{ seeded: boolean; created: number }> {
  if (seedCheckDone) return { seeded: false, created: 0 };
  try {
    const probe = await db.collection('skills').limit(1).get();
    if (!probe.empty) {
      seedCheckDone = true;
      return { seeded: false, created: 0 };
    }
    let created = 0;
    for (const skill of legacySkillSeeds()) {
      const data = {
        name: skill.name,
        slug: skill.slug,
        category: skill.category,
        status: skill.status,
      };
      await db.collection('skills').doc(skill.slug).set(data);
      // WS10 (public-skills population): this seed is one of the
      // fs_skills writers the skills flip was held on. Mirror each
      // seeded doc best-effort (the skills seam's mirrorSkillCreate,
      // the same helper migrate-legacy uses) so a seed that lands on
      // an empty collection also populates fs_skills; without it the
      // Supa read path stays empty and the public page falls back
      // forever. Never throws; a mirror failure cannot fail the seed.
      await mirrorSkillCreate(skill.slug, data);
      created += 1;
    }
    seedCheckDone = true;
    console.log(`[API:Skills] Auto-seeded ${created} legacy skills`);
    return { seeded: true, created };
  } catch (e) {
    console.error('[API:Skills] Auto-seed failed, will retry on a later request:', e);
    return { seeded: false, created: 0 };
  }
}

/** Test-only reset of the per-instance seed guard. */
export function __resetSkillsSeedGuard() {
  seedCheckDone = false;
}

export async function GET(request: NextRequest) {
  try {
    console.log('[API:Skills] Starting skills fetch...');

    // Ensure Firebase Admin is initialized before getting db
    const initOk = ensureAdminInitialized();
    if (!initOk) {
      console.error('[API:Skills] Firebase Admin initialization failed');
      return NextResponse.json({
        error: 'Server misconfiguration: Firebase Admin not initialized'
      }, { status: 500 });
    }

    const db = getDb();
    if (!db) {
      console.error('[API:Skills] Firestore not initialized');
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    const status = request.nextUrl.searchParams.get('status');
    const category = request.nextUrl.searchParams.get('category');
    const featured = request.nextUrl.searchParams.get('featured');
    const q = request.nextUrl.searchParams.get('q');

    console.log('[API:Skills] Query params:', { status, category, featured, q });

    // Supabase seam (step 6 scope: READ only — skills data writes are
    // step 8): flag ON + non-empty fs_skills serves the list; the
    // filtering/sorting below is shared by both sources. Flag OFF /
    // unconfigured / adapter error / empty Supabase list falls back
    // to the Firestore path (with its seed-on-empty behavior),
    // byte-identical.
    const supaRead = await readPublicSkillsViaSupa();
    let items: any[];
    if (supaRead.status === 'ok') {
      items = supaRead.docs.map((d) => ({ ...(d as any) }));
    } else {
      // Seed the legacy skills if the collection is empty. Best effort: a failed
      // seed never breaks the read path, and the guard above keeps this cheap.
      await ensureSkillsSeeded(db);

      const snap = await db.collection('skills').get();
      items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
    }
    
    console.log(`[API:Skills] Found ${items.length} total skills`);
    
    if (typeof status === 'string' && status && status !== '_all') items = items.filter((s) => String(s.status || 'active') === status);
    if (typeof category === 'string' && category && category !== '_all') items = items.filter((s) => String(s.category || '') === category);
    if (featured === '1') items = items.filter((s) => !!s.isFeatured === true);
    if (typeof q === 'string' && q.trim()) {
      const qq = q.trim().toLowerCase();
      items = items.filter((s) => String(s.name || '').toLowerCase().includes(qq));
    }
    
    items = items.sort((a: any, b: any) => {
      const ao = typeof a.displayOrder === 'number' ? a.displayOrder : 1e9;
      const bo = typeof b.displayOrder === 'number' ? b.displayOrder : 1e9;
      if (ao !== bo) return ao - bo;
      const an = String(a.name || '');
      const bn = String(b.name || '');
      return an.localeCompare(bn);
    });
    
    console.log(`[API:Skills] Returning ${items.length} filtered skills`);
    return NextResponse.json({ items });
  } catch (e: any) {
    console.error('[API:Skills] Error fetching skills:', e);
    return NextResponse.json({ error: e?.message || 'Failed to load skills' }, { status: 500 });
  }
}
