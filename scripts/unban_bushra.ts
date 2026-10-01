import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env.local') });

import { getDb } from '../src/lib/server/firebase-admin';

async function main() {
  console.log("Connecting to Firestore...");
  const db = getDb();
  if (!db) {
    console.error("Could not connect to db");
    process.exit(1);
  }

  const querySnap = await db.collection('users').where('email', '==', 'bushrarahman7766@gmail.com').get();
  if (querySnap.empty) {
    console.error("Could not find user bushrarahman7766@gmail.com");
    process.exit(1);
  }

  const userDoc = querySnap.docs[0];
  console.log(`Found user: ${userDoc.id}, updating isBanned to false...`);
  await userDoc.ref.update({
    isBanned: false
  });
  console.log("Successfully unbanned Bushra!");
  process.exit(0);
}

main().catch(console.error);
