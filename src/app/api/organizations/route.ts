// GET /api/organizations - Retrieve organizations for homepage marquee
import { NextRequest, NextResponse } from 'next/server';
import { admin, ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from '@/lib/auth/verifySession';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { isFounder } from '@/lib/roles';
import { filterPublicOrganizations } from '@/lib/finance/public-org-gate';
import {
  mapSupaOrganizationForList,
  mirrorOrganizationCreate,
  mirrorOrganizationDelete,
  mirrorOrganizationUpdate,
  readOrganizationsViaSupa,
} from '@/lib/server/organizations-supa';

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

    // Supabase seam (step 6): flag ON serves the organizations list
    // from fs_organizations; flag OFF / unconfigured / adapter error
    // falls back to the Firestore read below, byte-identical. (The
    // related-party gate further down still reads Firestore in both
    // modes — it is the CRM/consent clusters' surface.)
    const supaRead = await readOrganizationsViaSupa();
    if (supaRead.status === 'ok') {
      const organizations = supaRead.docs.map(mapSupaOrganizationForList);
      let filteredSupa = organizations;
      if (showOnHomepage) {
        filteredSupa = organizations.filter(org =>
          org.isActive === true && org.showOnHomepageMarquee === true
        );
      } else {
        filteredSupa = organizations.filter(org => org.isActive === true);
      }
      filteredSupa = await filterPublicOrganizations(db, filteredSupa);
      filteredSupa.sort((a, b) => {
        if (a.displayOrder !== b.displayOrder) {
          return a.displayOrder - b.displayOrder;
        }
        return a.name.localeCompare(b.name);
      });
      return NextResponse.json({
        organizations: filteredSupa,
        count: filteredSupa.length,
        timestamp: new Date().toISOString()
      });
    }

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
        partnerId: data.partnerId || null,
        logoUseGranted: data.logoUseGranted === true,
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

    // Related-party logo gate (CH-20, spec 6.5): server-side, against the
    // CRM record and the Phase 2 consent adapter. An organization linked
    // to a partner is included only when the CRM record is Active AND
    // (not related-party OR the related-party gate passes) AND logo use
    // was granted. Unlinked organizations are unaffected.
    filteredOrgs = await filterPublicOrganizations(db, filteredOrgs);

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

// POST /api/organizations - Create a new organization (requires canManageOrganizations; founder keeps access)
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
    if (!isFounder(decoded.uid)) {
      const gateDb = getDb();
      if (
        !gateDb ||
        !(await hasServerPermissionForUser(gateDb, decoded.uid, 'canManageOrganizations'))
      ) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
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
      isGlobal,
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
      // WS10: the admin page's create carries isGlobal in its form
      // data; the route used to drop it. Default matches the read
      // mappers (true when absent).
      isGlobal: isGlobal !== undefined ? isGlobal : true,
      description: description || '',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Add to Firestore
    const docRef = await db.collection('organizations').add(orgData);

    // Best-effort Supabase mirror (step 6 seam); never fails the create.
    await mirrorOrganizationCreate(docRef.id, orgData);

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
/* ------------------------------------------------------------------ */
/* WS10: PATCH + DELETE for the admin organizations page's writes      */
/* (previously client updateDoc/deleteDoc through firestore-wrapper;  */
/* `organizations` is not a webhook-dispatch collection, so no        */
/* replica effect exists). Same gate as POST: founder or               */
/* canManageOrganizations. Firestore primary + best-effort mirrors.    */
/* ------------------------------------------------------------------ */

async function requireOrganizationsAdmin(
  request: NextRequest,
): Promise<{ uid: string } | NextResponse> {
  const token = extractBearerHeader(request) ?? request.cookies.get('__session')?.value;
  if (!token) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await verifyIdTokenString(token);
  } catch {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }
  if (!ensureAdminInitialized()) {
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ error: 'Database not initialized' }, { status: 500 });
  if (!isFounder(decoded.uid)) {
    const allowed = await hasServerPermissionForUser(db, decoded.uid, 'canManageOrganizations');
    if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return { uid: decoded.uid };
}

const ORGANIZATION_FIELDS = [
  'name', 'logoUrl', 'websiteUrl', 'type', 'showOnHomepageMarquee',
  'displayOrder', 'isActive', 'isGlobal', 'description',
] as const;

/**
 * PATCH /api/organizations — body { id, fields, stampUpdatedAt? }.
 * The page's save-edit and visibility toggle stamped updatedAt; its
 * drag-reorder writes did not — stampUpdatedAt carries that
 * distinction so the stored docs stay field-identical.
 */
export async function PATCH(request: NextRequest) {
  const gate = await requireOrganizationsAdmin(request);
  if (gate instanceof NextResponse) return gate;
  const db = getDb()!;

  let body: Record<string, any>;
  try {
    body = (await request.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const fieldsIn =
    body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)
      ? (body.fields as Record<string, any>)
      : null;
  if (!id || !fieldsIn) {
    return NextResponse.json({ error: 'id and fields are required' }, { status: 400 });
  }
  if (fieldsIn.logoUrl !== undefined) {
    let parsedLogo: URL;
    try {
      parsedLogo = new URL(String(fieldsIn.logoUrl));
    } catch {
      return NextResponse.json({ error: 'Invalid logo URL' }, { status: 400 });
    }
    if (!['http:', 'https:'].includes(parsedLogo.protocol)) {
      return NextResponse.json({ error: 'Logo URL must use http(s)' }, { status: 400 });
    }
  }

  const update: Record<string, any> = {};
  for (const field of ORGANIZATION_FIELDS) {
    if (fieldsIn[field] !== undefined) update[field] = fieldsIn[field];
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No updatable fields' }, { status: 400 });
  }
  if (body.stampUpdatedAt === true) update.updatedAt = new Date();

  await db.collection('organizations').doc(id).update(update);
  await mirrorOrganizationUpdate(id, {
    ...update,
    ...(update.updatedAt ? { updatedAt: (update.updatedAt as Date).toISOString() } : {}),
  });
  return NextResponse.json({ ok: true, id });
}

/** DELETE /api/organizations — body { id }. */
export async function DELETE(request: NextRequest) {
  const gate = await requireOrganizationsAdmin(request);
  if (gate instanceof NextResponse) return gate;
  const db = getDb()!;

  let body: Record<string, any>;
  try {
    body = (await request.json()) as Record<string, any>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  await db.collection('organizations').doc(id).delete();
  await mirrorOrganizationDelete(id);
  return NextResponse.json({ ok: true, id });
}
