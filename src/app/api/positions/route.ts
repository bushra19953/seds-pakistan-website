import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { admin, getDb } from '@/lib/server/firebase-admin';
import { hasSufficientRole } from '@/lib/roles';
import { UserRole } from '@/lib/roles';
import { hasServerPermissionForUser } from '@/lib/server/permissions';
import { resolveRole } from '@/lib/role-catalog';
import { getRoleDisplayName as sharedGetRoleDisplayName } from '@/lib/roles';
import { isFounderAppointedOffice } from '@/lib/governance/office-permission-seeds';
import { FOUNDER_UID } from '@/config/founder';
import {
  assertConsentFor,
  canonicaliseRoleKey,
  consentGateHttpError,
  isCategoryBRole,
} from '@/lib/server/consent-gate';

/**
 * Firebase Admin Initialization (Production-Ready)
 */


export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { extractBearerToken as extractBearerHeader, verifyIdTokenString, SessionError } from '@/lib/auth/verifySession';

function extractBearerToken(request: NextRequest): string | undefined {
  // Prefer the Authorization header; fall back to the __session cookie for SSR flows.
  return extractBearerHeader(request) ?? request.cookies.get('__session')?.value ?? undefined;
}

async function authenticateRequest(request: NextRequest): Promise<{ decoded: admin.auth.DecodedIdToken } | { error: NextResponse } > {
  const token = extractBearerToken(request);
  if (!token) {
    console.warn('[positions:auth] Missing token');
    return { error: NextResponse.json({ error: 'Unauthorized: missing Bearer token', error_code: 'missing_token' }, { status: 401 }) };
  }
  let decoded: admin.auth.DecodedIdToken;
  try {
    // Shared session verification backed by the Firebase Admin SDK.
    decoded = await verifyIdTokenString(token);
  } catch (e: any) {
    if (e instanceof SessionError && e.statusCode === 500) {
      return { error: NextResponse.json({ error: e.message }, { status: 500 }) };
    }
    console.warn('[positions:auth] Token verification failed', { message: e?.message, code: e?.code });
    return { error: NextResponse.json({ error: 'Unauthorized: invalid token', error_code: 'token_invalid' }, { status: 401 }) };
  }
  console.debug('[positions:auth] Token verified', { uid: decoded.uid });
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (projectId) {
    const expectedIss = `https://securetoken.google.com/${projectId}`;
    if (decoded.iss !== expectedIss || decoded.aud !== projectId) {
      console.warn('[positions:auth] Issuer/audience mismatch', { iss: decoded.iss, aud: decoded.aud });
      return { error: NextResponse.json({ error: 'Unauthorized: token issued for different project', error_code: 'issuer_mismatch' }, { status: 401 }) };
    }
  }
  return { decoded };
}

async function checkPositionManagementPermission(uid: string, db: FirebaseFirestore.Firestore): Promise<boolean> {
  try {
    const user = await admin.auth().getUser(uid);
    const claims = user.customClaims || {};
    
    const hasClaimsPermission = !!(
      (claims.permissions && claims.permissions.managePositions === true) ||
      claims.managePositions === true ||
      claims.canManagePositions === true
    );
    
    if (hasClaimsPermission) return true;
    
    const roleSnap = await db.collection('roles').doc(uid).get();
    const role = roleSnap.exists ? String(roleSnap.data()?.role || '') : '';
    
    return await hasServerPermissionForUser(db, uid, 'canManagePositions');
  } catch (error) {
    console.error('Error checking position management permission:', error);
    return false;
  }
}

// Phase 1 (spec A.6): the local display table is replaced by the single
// display function in src/lib/roles.ts (imported below as sharedGetRoleDisplayName).

/**
 * GET /api/positions
 * Query positions with filtering and pagination
 */
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      console.error('[positions:route] GET handler blocked: Firestore not available');
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    
    const params = request.nextUrl.searchParams;
    const includeSensitiveData = params.get('admin') === 'true';
    
    let decoded: admin.auth.DecodedIdToken | null = null;
    if (includeSensitiveData) {
      const authResult = await authenticateRequest(request);
      if ('error' in authResult) return authResult.error;
      decoded = authResult.decoded;
    }

    const roleFilter = params.get('role');
    const userIdFilter = params.get('userId');
    const activeOnly = params.get('activeOnly') === 'true';
    const historicalOnly = params.get('historicalOnly') === 'true';
    const limitParam = Math.max(1, Math.min(100, Number(params.get('limit') || 50)));
    const cursorParam = params.get('cursor');

    // Build query
    let q: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = db.collection('positions') as any;
    const constraints: Array<{ apply: (q: any) => any }> = [];
    
    if (roleFilter) {
      constraints.push({ apply: (qq: any) => qq.where('role', '==', roleFilter) });
    }
    
    if (userIdFilter) {
      constraints.push({ apply: (qq: any) => qq.where('userId', '==', userIdFilter) });
    }
    
    if (activeOnly) {
      constraints.push({ apply: (qq: any) => qq.where('endDate', '==', null) });
    } else if (historicalOnly) {
      constraints.push({ apply: (qq: any) => qq.where('endDate', '!=', null) });
    }

    constraints.forEach((c) => { q = c.apply(q); });
    q = q.orderBy('startDate', 'desc');
    
    if (cursorParam) {
      const cursorMs = Number(cursorParam);
      if (Number.isFinite(cursorMs) && cursorMs > 0) {
        const ts = admin.firestore.Timestamp.fromMillis(cursorMs);
        q = q.startAfter(ts);
      }
    }
    
    q = q.limit(limitParam);

    const snap = await q.get();
    const positions = snap.docs.map((d) => {
      const data = d.data() as any;
      return {
        id: d.id,
        ...data,
        startDate: data.startDate?.toDate?.() || new Date(data.startDate),
        endDate: data.endDate?.toDate?.() || (data.endDate ? new Date(data.endDate) : null),
        createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt),
        updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt),
      };
    });

    const totalCountSnap = await db.collection('positions').get();
    const totalCount = totalCountSnap.size;

    const last = snap.docs[snap.docs.length - 1];
    const lastCreated = last ? (last.get('startDate') as FirebaseFirestore.Timestamp | undefined) : undefined;
    const nextCursor = lastCreated && typeof lastCreated.toMillis === 'function' ? String(lastCreated.toMillis()) : null;

    return NextResponse.json({
      ok: true,
      positions,
      pagination: {
        count: positions.length,
        totalCount,
        hasNext: !!nextCursor,
        nextCursor,
      }
    });
  } catch (error: any) {
    console.error('[positions:route] GET handler error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/positions
 * Create a new position with automated continuity management
 */
export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      console.error('[positions:route] POST handler blocked: Firestore not available');
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;
    const decoded = authResult.decoded;

    // Check permissions
    const canManage = await checkPositionManagementPermission(decoded.uid, db);
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden: insufficient privileges to manage positions' }, { status: 403 });
    }

    const body = await request.json();
    console.debug('[positions:route] CREATE body received', { body });

    // Validate input
    const PositionCreateSchema = z.object({
      role: z.string().min(1),
      userId: z.string().min(1),
      startDate: z.union([z.string(), z.number(), z.date()]),
      notes: z.string().optional(),
    });

    const parsed = PositionCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const { role, userId, startDate, notes } = parsed.data;

    // Phase 1 (spec D.4): the allow-list is the catalog. The incoming
    // token is resolved through the one map; the position stores the
    // catalog key. Founder-appointed offices additionally require the
    // appointing actor to be the Founder himself.
    const resolvedRole = resolveRole(role);
    if (resolvedRole.kind !== 'catalog' && resolvedRole.kind !== 'legacy') {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }
    const catalogRole = resolvedRole.key;
    if (isFounderAppointedOffice(catalogRole) && decoded.uid !== FOUNDER_UID) {
      return NextResponse.json(
        { error: 'Forbidden: this office is appointed by the Founder only' },
        { status: 403 },
      );
    }

    // Validate user exists
    const userSnap = await db.collection('users').doc(userId).get();
    if (!userSnap.exists) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Normalize start date
    let startDateObj: Date;
    if (typeof startDate === 'string') {
      startDateObj = new Date(startDate);
    } else if (typeof startDate === 'number') {
      startDateObj = new Date(startDate);
    } else {
      startDateObj = startDate as Date;
    }

    if (isNaN(startDateObj.getTime())) {
      return NextResponse.json({ error: 'Invalid start date' }, { status: 400 });
    }

    // Phase 2 consent gate (spec B.3a.4): appointing to a Category B
    // position is a Reserved Matter. Gate runs after all validation, as the
    // last check before the write.
    if (await isCategoryBRole(db, role)) {
      try {
        await assertConsentFor({
          db,
          actorUid: decoded.uid,
          matterKey: 'catb_officer',
          consentRequestId:
            typeof (body as Record<string, unknown>)?.consentRequestId === 'string'
              ? ((body as Record<string, unknown>).consentRequestId as string)
              : null,
          subjectRef: {
            type: 'position',
            targetUid: userId,
            roleKey: canonicaliseRoleKey(role),
            action: 'appoint',
          },
          actSummary: `Appoint ${userId} to position ${role}`,
        });
      } catch (err) {
        const { status, body: errBody } = consentGateHttpError(err);
        return NextResponse.json(errBody, { status });
      }
    }

    // Get user display name for metadata
    const userData = userSnap.data()!;
    const userDisplayName = userData.displayName || userData.email || 'Unknown';

    // Create position document
    const positionDoc = {
      role: catalogRole as UserRole,
      userId,
      startDate: startDateObj,
      endDate: null, // Current position
      appointedBy: decoded.uid,
      notes: notes || '',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        roleDisplayName: sharedGetRoleDisplayName(catalogRole as UserRole, userId),
        userDisplayName,
        appointedByDisplayName: 'Administrator'
      }
    };

    // Add to database
    const docRef = await db.collection('positions').add(positionDoc);

    console.log('[positions:route] Position created', { 
      positionId: docRef.id, 
      role, 
      userId, 
      startDate: startDateObj 
    });

    return NextResponse.json({
      ok: true,
      position: {
        id: docRef.id,
        ...positionDoc
      },
      message: 'Position created successfully. Previous position holder continuity will be updated automatically.'
    });
  } catch (error: any) {
    console.error('[positions:route] POST handler error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/positions
 * Update an existing position
 */
export async function PATCH(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      console.error('[positions:route] PATCH handler blocked: Firestore not available');
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;
    const decoded = authResult.decoded;

    // Check permissions
    const canManage = await checkPositionManagementPermission(decoded.uid, db);
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden: insufficient privileges to manage positions' }, { status: 403 });
    }

    const body = await request.json();
    console.debug('[positions:route] UPDATE body received', { body });

    // Validate input
    const PositionUpdateSchema = z.object({
      positionId: z.string().min(1),
      updates: z.object({
        startDate: z.union([z.string(), z.number(), z.date()]).optional(),
        endDate: z.union([z.string(), z.number(), z.date(), z.null()]).optional(),
        notes: z.string().optional(),
        role: z.string().optional(),
      }).passthrough(),
    });

    const parsed = PositionUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const { positionId, updates } = parsed.data;

    // Check if position exists
    const positionRef = db.collection('positions').doc(positionId);
    const positionSnap = await positionRef.get();
    if (!positionSnap.exists) {
      return NextResponse.json({ error: 'Position not found' }, { status: 404 });
    }

    const positionData = positionSnap.data()!;
    
    // Normalize updates
    const updatesToApply: Record<string, any> = { ...updates };
    
    if (updatesToApply.startDate) {
      let startDateObj: Date;
      if (typeof updatesToApply.startDate === 'string') {
        startDateObj = new Date(updatesToApply.startDate);
      } else if (typeof updatesToApply.startDate === 'number') {
        startDateObj = new Date(updatesToApply.startDate);
      } else {
        startDateObj = updatesToApply.startDate as Date;
      }
      
      if (isNaN(startDateObj.getTime())) {
        return NextResponse.json({ error: 'Invalid start date' }, { status: 400 });
      }
      
      updatesToApply.startDate = startDateObj;
    }
    
    if (updatesToApply.endDate !== undefined) {
      if (updatesToApply.endDate === null) {
        updatesToApply.endDate = null; // Making position current
      } else {
        let endDateObj: Date;
        if (typeof updatesToApply.endDate === 'string') {
          endDateObj = new Date(updatesToApply.endDate);
        } else if (typeof updatesToApply.endDate === 'number') {
          endDateObj = new Date(updatesToApply.endDate);
        } else {
          endDateObj = updatesToApply.endDate as Date;
        }
        
        if (isNaN(endDateObj.getTime())) {
          return NextResponse.json({ error: 'Invalid end date' }, { status: 400 });
        }
        
        updatesToApply.endDate = endDateObj;
      }
    }

    // Validate role if provided
    if (updatesToApply.role) {
      const validRoles = new Set([
        'superadmin', 'president_national', 'president_chapter', 'vice_president',
        'general_secretary', 'projects_director', 'marketing_head', 'hr_director',
        'treasurer', 'advisor', 'chair_projects', 'chair_marketing', 'chair_outreach',
        'chair_design', 'chair_alumni', 'chair_events', 'chair_recruitment',
        'chair_ethics', 'chair_sponsorship', 'rocketry_team', 'cubesat_team',
        'rover_team', 'member', 'guest'
      ]);

      if (!validRoles.has(updatesToApply.role)) {
        return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
      }
    }

    // Phase 2 consent gate (spec B.3a.4): ending a CURRENT Category B
    // position is a removal; changing the role to a Category B role is an
    // appointment. Notes/dates-only edits are not gated. Gate runs last,
    // after all validation, before the write.
    const patchConsentId =
      typeof (body as Record<string, unknown>)?.consentRequestId === 'string'
        ? ((body as Record<string, unknown>).consentRequestId as string)
        : null;
    try {
      if (
        updatesToApply.endDate !== undefined &&
        updatesToApply.endDate !== null &&
        positionData.endDate == null &&
        (await isCategoryBRole(db, String(positionData.role ?? '')))
      ) {
        await assertConsentFor({
          db,
          actorUid: decoded.uid,
          matterKey: 'catb_officer',
          consentRequestId: patchConsentId,
          subjectRef: {
            type: 'position',
            targetUid: String(positionData.userId),
            roleKey: canonicaliseRoleKey(String(positionData.role)),
            action: 'remove',
          },
          actSummary: `End position ${positionId} (${String(positionData.role)})`,
        });
      }
      if (updatesToApply.role && (await isCategoryBRole(db, String(updatesToApply.role)))) {
        await assertConsentFor({
          db,
          actorUid: decoded.uid,
          matterKey: 'catb_officer',
          consentRequestId: patchConsentId,
          subjectRef: {
            type: 'position',
            targetUid: String(positionData.userId),
            roleKey: canonicaliseRoleKey(String(updatesToApply.role)),
            action: 'appoint',
          },
          actSummary: `Change position ${positionId} to ${String(updatesToApply.role)}`,
        });
      }
    } catch (err) {
      const { status, body: errBody } = consentGateHttpError(err);
      return NextResponse.json(errBody, { status });
    }

    // Always set updatedAt server-side
    updatesToApply.updatedAt = new Date();

    // Update the position
    await positionRef.update(updatesToApply);

    console.log('[positions:route] Position updated', { 
      positionId, 
      updates: updatesToApply 
    });

    return NextResponse.json({
      ok: true,
      positionId,
      updates: updatesToApply,
      message: 'Position updated successfully.'
    });
  } catch (error: any) {
    console.error('[positions:route] PATCH handler error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/positions
 * Delete a position (use with caution - creates audit log)
 */
export async function DELETE(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      console.error('[positions:route] DELETE handler blocked: Firestore not available');
      return NextResponse.json({ error: 'Internal Server Error: Firestore not initialized' }, { status: 500 });
    }
    
    const authResult = await authenticateRequest(request);
    if ('error' in authResult) return authResult.error;
    const decoded = authResult.decoded;

    // Check permissions
    const canManage = await checkPositionManagementPermission(decoded.uid, db);
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden: insufficient privileges to delete positions' }, { status: 403 });
    }

    const body = await request.json();
    console.debug('[positions:route] DELETE body received', { body });

    const { positionId } = body;
    if (!positionId || typeof positionId !== 'string') {
      return NextResponse.json({ error: 'Position ID is required' }, { status: 400 });
    }

    const positionRef = db.collection('positions').doc(positionId);
    const positionSnap = await positionRef.get();
    
    if (!positionSnap.exists) {
      return NextResponse.json({ error: 'Position not found' }, { status: 404 });
    }

    const positionData = positionSnap.data()!;

    // Phase 2 consent gate (spec B.3a.4): deleting a CURRENT Category B
    // position removes the holder's authority - gated as a removal.
    // Deleting an already-ended historical record is record-keeping, not an
    // act on a Reserved Matter, and is not gated.
    if (positionData.endDate == null && (await isCategoryBRole(db, String(positionData.role ?? '')))) {
      try {
        await assertConsentFor({
          db,
          actorUid: decoded.uid,
          matterKey: 'catb_officer',
          consentRequestId:
            typeof (body as Record<string, unknown>)?.consentRequestId === 'string'
              ? ((body as Record<string, unknown>).consentRequestId as string)
              : null,
          subjectRef: {
            type: 'position',
            targetUid: String(positionData.userId),
            roleKey: canonicaliseRoleKey(String(positionData.role)),
            action: 'remove',
          },
          actSummary: `Delete current position ${positionId} (${String(positionData.role)})`,
        });
      } catch (err) {
        const { status, body: errBody } = consentGateHttpError(err);
        return NextResponse.json(errBody, { status });
      }
    }

    // Create audit log before deletion
    const auditEntry = {
      type: 'position_deletion',
      action: 'position_deleted',
      positionId,
      deletedBy: decoded.uid,
      positionData: {
        role: positionData.role,
        userId: positionData.userId,
        startDate: positionData.startDate,
        endDate: positionData.endDate,
        appointedBy: positionData.appointedBy,
      },
      deletedAt: new Date(),
      reason: 'Manual deletion by administrator'
    };
    
    await db.collection('audit_logs').add(auditEntry);

    // Delete the position
    await positionRef.delete();

    console.log('[positions:route] Position deleted', { 
      positionId, 
      role: positionData.role,
      userId: positionData.userId 
    });

    return NextResponse.json({
      ok: true,
      positionId,
      message: 'Position deleted successfully. Audit log created.'
    });
  } catch (error: any) {
    console.error('[positions:route] DELETE handler error:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', details: error?.message ?? String(error) },
      { status: 500 }
    );
  }
}