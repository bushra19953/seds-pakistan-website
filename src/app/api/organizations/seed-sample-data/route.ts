import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

export async function POST(request: NextRequest) {
  try {
    console.log('[organizations:seed] Seeding sample data');
    
    const initOk = ensureAdminInitialized();
    if (!initOk) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not available' }, { status: 500 });
    }

    // Sample organizations data
    const sampleOrganizations = [
      {
        name: "SEDS Pakistan - Karachi Chapter",
        logoUrl: "/assets/chapters/karachi-logo.png",
        websiteUrl: "https://seds-pakistan.vercel.app/karachi",
        type: "National Chapter",
        showOnHomepageMarquee: true,
        displayOrder: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        name: "SEDS Pakistan - Islamabad Chapter",
        logoUrl: "/assets/chapters/islamabad-logo.png",
        websiteUrl: "https://seds-pakistan.vercel.app/islamabad",
        type: "National Chapter",
        showOnHomepageMarquee: true,
        displayOrder: 2,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        name: "SEDS Pakistan - Lahore Chapter",
        logoUrl: "/assets/chapters/lahore-logo.png",
        websiteUrl: "https://seds-pakistan.vercel.app/lahore",
        type: "National Chapter",
        showOnHomepageMarquee: true,
        displayOrder: 3,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        name: "National University of Sciences & Technology (NUST)",
        logoUrl: "/assets/partners/nust-logo.png",
        websiteUrl: "https://nust.edu.pk",
        type: "Institutional Partner",
        showOnHomepageMarquee: true,
        displayOrder: 1,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        name: "Pakistan Institute of Engineering & Applied Sciences (PIEAS)",
        logoUrl: "/assets/partners/pieas-logo.png",
        websiteUrl: "https://pieas.edu.pk",
        type: "Institutional Partner",
        showOnHomepageMarquee: true,
        displayOrder: 2,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        name: "COMSATS University Islamabad",
        logoUrl: "/assets/partners/comsats-logo.png",
        websiteUrl: "https://comsats.edu.pk",
        type: "University",
        showOnHomepageMarquee: true,
        displayOrder: 3,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        name: "SUPARCO (Space & Upper Atmosphere Research Commission)",
        logoUrl: "/assets/partners/suparco-logo.png",
        websiteUrl: "https://suparco.gov.pk",
        type: "Institutional Partner",
        showOnHomepageMarquee: true,
        displayOrder: 4,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    ];

    // Clear existing data first
    console.log('[organizations:seed] Clearing existing organizations');
    const existingSnap = await db.collection('organizations').get();
    const batch = db.batch();
    existingSnap.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    // Add sample data
    console.log('[organizations:seed] Adding sample organizations');
    const seedBatch = db.batch();
    sampleOrganizations.forEach((org) => {
      const docRef = db.collection('organizations').doc();
      seedBatch.set(docRef, org);
    });
    
    await seedBatch.commit();

    return NextResponse.json({
      message: 'Sample organizations data seeded successfully',
      count: sampleOrganizations.length,
      data: sampleOrganizations
    });

  } catch (error: any) {
    console.error('[organizations:seed] Error seeding data:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to seed sample data' },
      { status: 500 }
    );
  }
}