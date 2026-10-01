const admin = require('firebase-admin');

function init() {
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    try {
      admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
    } catch {
      admin.initializeApp();
    }
  }
  return admin.firestore();
}

async function backfillNotifications(db) {
  const usersSnap = await db.collection('users').get();
  for (const userDoc of usersSnap.docs) {
    const subRef = db.collection('users').doc(userDoc.id).collection('notifications');
    const notifSnap = await subRef.get();
    for (const d of notifSnap.docs) {
      const data = d.data();
      const ts = data.timestamp;
      const ca = data.createdAt;
      let newTs = null;
      if (typeof ts === 'string' || typeof ts === 'number') newTs = admin.firestore.Timestamp.fromDate(new Date(ts));
      else if (ca && (typeof ca === 'string' || typeof ca === 'number')) newTs = admin.firestore.Timestamp.fromDate(new Date(ca));
      if (newTs) {
        await d.ref.set({ timestamp: newTs }, { merge: true });
      }
    }
  }
}

async function backfillMessages(db) {
  let last = null;
  while (true) {
    let q = db.collection('messages').orderBy('createdAt').limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      const data = d.data();
      const ca = data.createdAt;
      if (typeof ca === 'string' || typeof ca === 'number') {
        const ts = admin.firestore.Timestamp.fromDate(new Date(ca));
        await d.ref.set({ createdAt: ts }, { merge: true });
      }
    }
    last = snap.docs[snap.docs.length - 1];
  }
}

async function main() {
  const db = init();
  await backfillNotifications(db);
  await backfillMessages(db);
  console.log('Backfill completed');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });