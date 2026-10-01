import { getDb } from "@/lib/server/firebase-admin";

function tokens(dn: string, em: string) {
  const nameTokens = dn.toLowerCase().split(/\s+/).filter(Boolean);
  const emLower = em.toLowerCase();
  const local = emLower.split('@')[0] || '';
  const prefixes = (s: string) => {
    const out: string[] = [];
    for (let i = 2; i <= Math.min(s.length, 32); i++) out.push(s.slice(0, i));
    return out;
  };
  const tokenPrefixes = nameTokens.flatMap(prefixes);
  const localPrefixes = prefixes(local);
  return Array.from(new Set([...nameTokens, ...tokenPrefixes, emLower, local, ...localPrefixes])).filter(Boolean);
}

export async function backfillSearchableIndex() {
  const db = getDb();
  if (!db) throw new Error('Firestore not initialized');
  const snap = await db.collection("users").get();
  const batch = db.batch();
  snap.docs.forEach((doc: any) => {
    const data = doc.data() || {};
    const dn = String(data.displayName || data.name || "").trim();
    const em = String(data.email || "").trim();
    const searchableIndex = tokens(dn, em);
    batch.update(doc.ref, { searchableIndex });
  });
  await batch.commit();
}

if (require.main === module) {
  backfillSearchableIndex().then(() => {
    process.exit(0);
  }).catch(() => {
    process.exit(1);
  });
}