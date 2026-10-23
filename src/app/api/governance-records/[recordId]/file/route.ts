import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { getDb } from '@/lib/server/firebase-admin';
import { verifyAuthentication } from '@/lib/auth-middleware';
import { getDriveFileStream } from '@/lib/drive/client';
import { canAccessRecord, type GovernanceCaller } from '@/lib/governance/access';
import { writeGovernanceAudit } from '@/lib/governance/audit';
import { isPublishable } from '@/lib/governance/redaction-guard';
import { isGovernancePublicationEnabled } from '@/lib/governance/publication';
import { loadRecord } from '@/lib/governance/record-io';
import {
  hasServerPermissionForUser,
  resolveUserRole,
} from '@/lib/server/permissions';
import type {
  AccessLevel,
  GovernanceSeries,
  RedactionStatus,
} from '@/lib/governance/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ANON_CALLER: GovernanceCaller = {
  uid: null,
  hasProfile: false,
  role: null,
  chapterId: null,
  permissions: [],
};

// GET: the ONLY route that serves governance record bytes (spec 4.3).
// It streams from Drive; visitors are never redirected to a Drive URL.
// Anonymous callers get 404 for anything they could not know about -
// the response never distinguishes "does not exist" from "not public".
export async function GET(
  request: NextRequest,
  { params }: { params: { recordId: string } },
) {
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Database not initialized' },
      { status: 500 },
    );
  }
  const raw = await loadRecord(db as never, params.recordId);

  // Resolve the caller. A failed/expired token degrades to anonymous.
  let caller: GovernanceCaller = ANON_CALLER;
  let authenticated = false;
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const auth = await verifyAuthentication(request);
    if (auth.authenticated && auth.user) {
      authenticated = true;
      const uid = auth.user.userId;
      const role =
        (await resolveUserRole(db as never, uid)) ||
        auth.user.role ||
        'member';
      const userSnap = await db.collection('users').doc(uid).get();
      const userData = userSnap.exists ? userSnap.data() : null;
      const permissions: string[] = [];
      if (
        await hasServerPermissionForUser(
          db as never,
          uid,
          'canManageGovernanceRecords',
        )
      ) {
        permissions.push('canManageGovernanceRecords');
      }
      if (
        await hasServerPermissionForUser(
          db as never,
          uid,
          'canApproveGovernanceRecords',
        )
      ) {
        permissions.push('canApproveGovernanceRecords');
      }
      caller = {
        uid,
        hasProfile: userSnap.exists,
        role,
        chapterId:
          typeof userData?.chapterId === 'string'
            ? userData.chapterId
            : null,
        permissions,
      };
    }
  }

  if (!raw) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const accessLevel = raw.accessLevel as AccessLevel;
  const status = raw.status as string;
  const publishable = isPublishable({
    series: raw.series as GovernanceSeries,
    accessLevel,
    redactionStatus: raw.redactionStatus as RedactionStatus,
  });

  if (!authenticated) {
    // Anonymous serving additionally requires: publication flag ON
    // (held OFF until Zubair approves go-live), public tier, approved or
    // effective status, and a passing redaction guard.
    const servable =
      isGovernancePublicationEnabled() &&
      accessLevel === 'public' &&
      (status === 'approved' || status === 'effective') &&
      publishable;
    if (!servable) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  } else {
    if (!canAccessRecord(caller, raw as never)) {
      await writeGovernanceAudit(
        'GOVERNANCE_RECORD_ACCESS_DENIED',
        caller.uid,
        params.recordId,
        { accessLevel },
      );
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // A signed-in caller who passes the tier check but faces a public
    // shape blocked by the guard (bad state) still gets nothing public;
    // officers manage it through the admin API instead.
    if (accessLevel === 'public' && !publishable) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

  if (!raw.driveFileId) {
    return NextResponse.json(
      { error: 'Record has no attached file', code: 'no-file' },
      { status: 409 },
    );
  }

  let stream;
  try {
    stream = await getDriveFileStream(raw.driveFileId as string);
  } catch (e) {
    console.error('[governance file] Drive stream failed:', e);
    return NextResponse.json(
      { error: 'Could not read the file from Drive', code: 'drive-error' },
      { status: 502 },
    );
  }

  await writeGovernanceAudit(
    'GOVERNANCE_RECORD_ACCESSED',
    caller.uid,
    params.recordId,
    { accessLevel, anonymous: !authenticated },
  );

  const headers = new Headers();
  headers.set(
    'Content-Type',
    (raw.mimeType as string) || 'application/octet-stream',
  );
  if (typeof raw.sizeBytes === 'number') {
    headers.set('Content-Length', String(raw.sizeBytes));
  }
  if (request.nextUrl.searchParams.get('download') === '1') {
    headers.set(
      'Content-Disposition',
      `attachment; filename="${String(raw.fileName || 'document').replace(/"/g, '')}"`,
    );
  }
  headers.set(
    'Cache-Control',
    accessLevel === 'public'
      ? 'public, max-age=300'
      : 'private, no-store',
  );
  const webStream = Readable.toWeb(
    stream as Readable,
  ) as unknown as ReadableStream;
  return new NextResponse(webStream, { headers });
}
