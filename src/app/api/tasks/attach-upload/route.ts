/**
 * POST /api/tasks/attach-upload
 *
 * Standalone endpoint that lets a client attach an already-uploaded Drive file
 * to a task immediately, without going through the full submit flow.
 *
 * Body (JSON):
 *   {
 *     "taskId": "<task doc id>",
 *     "file": {
 *       "fileName": "name.pdf",
 *       "driveFileId": "<drive file id>",
 *       "downloadUrl": "https://...",
 *       "webViewLink": "https://...",
 *       "sizeBytes": 12345,
 *       "mimeType": "application/pdf"
 *     }
 *   }
 *
 * Auth: Firebase ID token (Authorization header or __session cookie).
 * Authorization: caller must be the task assignee (task.assigneeId or within
 * task.assigneeIds) OR have canManageTasks permission; otherwise 403.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { admin, getDb } from '@/lib/server/firebase-admin';
import {
  extractBearerToken as extractBearerHeader,
  verifyIdTokenString,
  SessionError,
} from '@/lib/auth/verifySession';
import { hasServerPermission, resolveUserRole } from '@/lib/server/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function extractBearerToken(request: NextRequest): string | undefined {
  return extractBearerHeader(request) ?? request.cookies.get('__session')?.value ?? undefined;
}

async function authenticateRequest(request: NextRequest) {
  const token = extractBearerToken(request);
  if (!token) {
    return {
      error: NextResponse.json(
        { error: 'Unauthorized: missing Bearer token', error_code: 'missing_token' },
        { status: 401 }
      ),
    };
  }
  try {
    const decoded = await verifyIdTokenString(token);
    const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (projectId) {
      const expectedIss = `https://securetoken.google.com/${projectId}`;
      if (decoded.iss !== expectedIss || decoded.aud !== projectId) {
        return {
          error: NextResponse.json(
            { error: 'Unauthorized: token issued for different project', error_code: 'issuer_mismatch' },
            { status: 401 }
          ),
        };
      }
    }
    return { decoded };
  } catch (e: any) {
    if (e instanceof SessionError && e.statusCode === 500) {
      return { error: NextResponse.json({ error: e.message }, { status: 500 }) };
    }
    return {
      error: NextResponse.json(
        { error: 'Unauthorized: invalid token', error_code: 'token_invalid' },
        { status: 401 }
      ),
    };
  }
}

const fileSchema = z.object({
  fileName: z.string().min(1),
  driveFileId: z.string().min(1),
  downloadUrl: z.string().optional(),
  webViewLink: z.string().optional(),
  sizeBytes: z.number().optional(),
  mimeType: z.string().optional(),
});

const bodySchema = z.object({
  taskId: z.string().min(1),
  file: fileSchema,
});

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ('error' in auth) return auth.error;
  const uid = auth.decoded.uid;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch (e: any) {
    return NextResponse.json(
      { error: 'Invalid request body', error_code: 'invalid_body', details: e?.message },
      { status: 400 }
    );
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: 'Database not available', error_code: 'db_unavailable' },
      { status: 500 }
    );
  }
  const taskRef = db.collection('tasks').doc(body.taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    return NextResponse.json(
      { error: 'Task not found', error_code: 'task_not_found' },
      { status: 404 }
    );
  }
  const taskData = taskSnap.data() as Record<string, any>;

  const isAssignee =
    taskData.assigneeId === uid ||
    (Array.isArray(taskData.assigneeIds) && taskData.assigneeIds.includes(uid));

  const role = await resolveUserRole(db, uid);
  const canManage = await hasServerPermission(role, 'canManageTasks');

  if (!isAssignee && !canManage) {
    return NextResponse.json(
      { error: 'Forbidden: you are not assigned to this task', error_code: 'not_assigned' },
      { status: 403 }
    );
  }

  const fileRecord: Record<string, any> = {
    fileName: body.file.fileName,
    driveFileId: body.file.driveFileId,
    ...(body.file.downloadUrl ? { downloadUrl: body.file.downloadUrl } : {}),
    ...(body.file.webViewLink ? { webViewLink: body.file.webViewLink } : {}),
    ...(typeof body.file.sizeBytes === 'number' ? { sizeBytes: body.file.sizeBytes } : {}),
    ...(body.file.mimeType ? { contentType: body.file.mimeType } : {}),
    uploadedBy: uid,
    uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await taskRef.update({
    deliverableFiles: admin.firestore.FieldValue.arrayUnion(fileRecord),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return NextResponse.json({ ok: true });
}
