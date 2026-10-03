// GET /api/organizations - Retrieve organizations for homepage marquee
import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { resolveUserRole } from '@/lib/server/permissions';
import { isSuperAdmin } from '@/lib/roles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const showOnHomepage = searchParams.get('showOnHomepage') === 'true';

    // Ensure Firebase Admin is initialized before getting db
    const initOk = ensureAdminInitialized();
    if (!initOk) {
      return NextResponse.json(
        { error: 'Server misconfiguration: Firebase Admin not initialized' },
        { status: 500 }
      );
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json(
        { error: 'Database not initialized' },
        { status: 500 }
      );
    }

    console.log('[organizations:route] Request details:', {
      url: request.url,
      showOnHomepage: showOnHomepage,
      timestamp: new Date().toISOString()
    });

    // Simplified query - just get all organizations first, then filter
    const querySnapshot = await db.collection('organizations').get();
    const organizations: any[] = [];

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      organizations.push({
        id: doc.id,
        name: data.name || '',
        logoUrl: data.logoUrl || '',
        websiteUrl: data.websiteUrl || '',
        type: data.type || 'National Chapter',
        showOnHomepageMarquee: data.showOnHomepageMarquee || false,
        displayOrder: data.displayOrder || 0,
        isActive: data.isActive || false,
        isGlobal: data.isGlobal !== undefined ? data.isGlobal : true,
        description: data.description || '',
        createdAt: data.createdAt?.toDate() || new Date(),
        updatedAt: data.updatedAt?.toDate() || new Date(),
      });
    });

    // Filter on the server-side to avoid composite index requirements
    let filteredOrgs = organizations;
    if (showOnHomepage) {
      filteredOrgs = organizations.filter(org => 
        org.isActive === true && org.showOnHomepageMarquee === true
      );
    } else {
      filteredOrgs = organizations.filter(org => org.isActive === true);
    }

    // Sort by display order then name
    filteredOrgs.sort((a, b) => {
      if (a.displayOrder !== b.displayOrder) {
        return a.displayOrder - b.displayOrder;
      }
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({
      organizations: filteredOrgs,
      count: filteredOrgs.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error fetching organizations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch organizations' },
      { status: 500 }
    );
  }
}

// POST /api/organizations - Create a new organization (requires superadmin)
export async function POST(request: NextRequest) {
  try {
    const token = extractBearerHeader(request) ?? request.cookies.get('__session')?.value;
    if (!token) {
      return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    }
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await verifyIdTokenString(token);
    } catch {
      return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
    }
    const role = await resolveUserRole(decoded.uid);
    if (!isSuperAdmin(role, decoded.uid)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    
    const {
      name,
      logoUrl,
      websiteUrl,
      type,
      showOnHomepageMarquee,
      displayOrder,
      isActive,
      description,
    } = body;

    // Validation
    if (!name || !logoUrl) {
      return NextResponse.json(
        { error: 'Name and logo URL are required' },
        { status: 400 }
      );
    }

    // logoUrl renders on the public homepage: only allow http(s) URLs to
    // block javascript:/data: stored-XSS payloads.
    let parsedLogo: URL;
    try {
      parsedLogo = new URL(String(logoUrl));
    } catch {
      return NextResponse.json({ error: 'Invalid logo URL' }, { status: 400 });
    }
    if (!['http:', 'https:'].includes(parsedLogo.protocol)) {
      return NextResponse.json({ error: 'Logo URL must use http(s)' }, { status: 400 });
    }

    const db = getDb();
    if (!db) {
      return NextResponse.json(
        { error: 'Database not initialized' },
        { status: 500 }
      );
    }

    // Create the organization document
    const orgData = {
      name,
      logoUrl,
      websiteUrl: websiteUrl || '',
      type: type || 'National Chapter',
      showOnHomepageMarquee: showOnHomepageMarquee || false,
      displayOrder: typeof displayOrder === 'number' ? displayOrder : 0,
      isActive: isActive !== undefined ? isActive : true,
      description: description || '',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Add to Firestore
    const docRef = await db.collection('organizations').add(orgData);

    return NextResponse.json({
      id: docRef.id,
      ...orgData,
      message: 'Organization created successfully'
    });

  } catch (error) {
    console.error('Error creating organization:', error);
    return NextResponse.json(
      { error: 'Failed to create organization' },
      { status: 500 }
    );
  }
}