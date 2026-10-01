import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb, admin } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LEGACY: Array<{ name: string; category?: string; status?: string }> = [
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

export async function POST(request: NextRequest) {
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try { await admin.auth().verifyIdToken(token); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  const created: string[] = [];
  const updated: string[] = [];
  for (const item of LEGACY) {
    const slug = slugify(item.name);
    const snap = await db.collection('skills').where('slug', '==', slug).limit(1).get();
    if (snap.empty) {
      const ref = await db.collection('skills').add({ name: item.name, slug, category: item.category || '', status: item.status || 'active' });
      created.push(ref.id);
    } else {
      const ref = snap.docs[0].ref;
      await ref.set({ name: item.name, category: item.category || '', status: item.status || 'active' }, { merge: true });
      updated.push(ref.id);
    }
  }
  return NextResponse.json({ created: created.length, updated: updated.length });
}

