import { NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb, getAdminDiagnostics } from '@/lib/server/firebase-admin';

// Configure for dynamic rendering and Node.js runtime for Admin SDK
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    // Ensure Firebase Admin is initialized before getting db
    const initOk = ensureAdminInitialized();
    if (!initOk) {
      return NextResponse.json(
        { error: 'Server misconfiguration: Firebase Admin not initialized', diagnostics: getAdminDiagnostics() },
        { status: 500 }
      );
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json(
        { error: 'Firestore Admin not initialized', diagnostics: getAdminDiagnostics() },
        { status: 500 }
      );
    }
    console.log('[test-blogs] Fetching blog data...');

    // Get all blogs
    const allSnapshot = await db.collection('blogs').get();
    console.log('[test-blogs] Total blogs:', allSnapshot.size);

    const allBlogs: any[] = [];
    allSnapshot.forEach((doc) => {
      allBlogs.push({ id: doc.id, ...doc.data() });
    });

    // Get published blogs (new schema)
    const publishedSnapshot = await db
      .collection('blogs')
      .where('status', '==', 'published')
      .get();
    console.log('[test-blogs] Published blogs (status=published):', publishedSnapshot.size);

    const publishedBlogs: any[] = [];
    publishedSnapshot.forEach((doc) => {
      publishedBlogs.push({ id: doc.id, ...doc.data() });
    });

    // Get old published blogs (legacy boolean flag)
    const oldPublishedSnapshot = await db
      .collection('blogs')
      .where('published', '==', true)
      .get();
    console.log('[test-blogs] Old published blogs (published=true):', oldPublishedSnapshot.size);

    const oldPublishedBlogs: any[] = [];
    oldPublishedSnapshot.forEach((doc) => {
      oldPublishedBlogs.push({ id: doc.id, ...doc.data() });
    });

    return NextResponse.json({
      total: allBlogs.length,
      published: publishedBlogs.length,
      oldPublished: oldPublishedBlogs.length,
      allBlogs: allBlogs.slice(0, 10),
      publishedBlogs: publishedBlogs.slice(0, 10),
      oldPublishedBlogs: oldPublishedBlogs.slice(0, 10),
    });
  } catch (error: any) {
    console.error('[test-blogs] Error fetching blog data:', error);
    return NextResponse.json({ error: error?.message ?? String(error) }, { status: 500 });
  }
}
