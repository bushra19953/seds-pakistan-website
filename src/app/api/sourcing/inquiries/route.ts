import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
    }

    // Fetch all inquiries from 'sourcing_inquiries' collection
    const snapshot = await db.collection('sourcing_inquiries').get();

    const inquiries = snapshot.docs
      .map((doc) => {
        const data = doc.data();
        const rawCreated = data.createdAt || data.submittedAt || data.updatedAt;
        const createdDate = rawCreated?.toDate 
          ? rawCreated.toDate() 
          : (rawCreated ? new Date(rawCreated) : new Date());

        const rawUpdated = data.updatedAt || rawCreated;
        const updatedDate = rawUpdated?.toDate
          ? rawUpdated.toDate()
          : (rawUpdated ? new Date(rawUpdated) : new Date());

        return {
          id: doc.id,
          ...data,
          createdAt: createdDate.toISOString(),
          updatedAt: updatedDate.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return NextResponse.json({
      success: true,
      inquiries,
      count: inquiries.length,
    });
  } catch (error: any) {
    console.error('Error in GET /api/sourcing/inquiries:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch sourcing inquiries' },
      { status: 500 }
    );
  }
}
