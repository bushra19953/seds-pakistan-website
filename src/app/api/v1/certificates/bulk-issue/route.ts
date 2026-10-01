import { NextRequest, NextResponse } from 'next/server';
import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import { hasServerPermission } from '@/lib/server/permissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function extractBearerToken(request: NextRequest): string | undefined {
    const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring('Bearer '.length).trim();
    }
    return request.cookies.get('__session')?.value;
}

async function authenticateRequest(request: NextRequest): Promise<{ decoded: admin.auth.DecodedIdToken } | { error: NextResponse }> {
    if (!ensureAdminInitialized()) {
        return { error: NextResponse.json({ error: 'Server not initialized' }, { status: 500 }) };
    }
    const token = extractBearerToken(request);
    if (!token) {
        return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    try {
        const decoded = await admin.auth().verifyIdToken(token);
        return { decoded };
    } catch {
        return { error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) };
    }
}

function generateCode(): string {
    return `${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-6)}`.toUpperCase();
}

interface BulkIssueRequest {
    userIds: string[];
    certificateData: {
        title: string;
        description?: string;
        certificateType?: string;
        templateId?: string;
        templateUrl?: string;
        issuingAuthority?: string;
        issueDate?: string;
        expiresAt?: string;
    };
}

interface IssueResult {
    userId: string;
    userName: string;
    code: string;
    success: boolean;
    error?: string;
}

/**
 * POST /api/v1/certificates/bulk-issue
 * 
 * Bulk issue certificates to multiple users with shared certificate data.
 * Supports up to 100 users per request for scalability.
 * 
 * Body:
 *   userIds: string[] - Array of user UIDs to issue certificates to
 *   certificateData: object - Shared certificate fields (title, type, etc.)
 * 
 * Returns:
 *   issued: number - Count of successfully issued certificates
 *   failed: number - Count of failed issuances
 *   results: IssueResult[] - Detailed results for each user
 */
export async function POST(request: NextRequest) {
    const startTime = Date.now();

    try {
        console.log('[bulk-issue] Starting bulk certificate issuance');

        const authResult = await authenticateRequest(request);
        if ('error' in authResult) return authResult.error;
        const decoded = authResult.decoded;

        const db = getDb();
        if (!db) {
            return NextResponse.json({ error: 'Database not available' }, { status: 500 });
        }

        // Check permissions
        const roleSnap = await db.collection('roles').doc(decoded.uid).get();
        const role = roleSnap.exists ? (roleSnap.data()?.role as string | undefined) : undefined;
        const canIssue = await hasServerPermission(role, 'canManageCertificates');

        if (!canIssue) {
            return NextResponse.json({ error: 'Forbidden: insufficient privileges' }, { status: 403 });
        }

        const body: BulkIssueRequest = await request.json();
        const { userIds, certificateData } = body;

        // Validation
        if (!Array.isArray(userIds) || userIds.length === 0) {
            return NextResponse.json({ error: 'No users selected' }, { status: 400 });
        }
        if (userIds.length > 100) {
            return NextResponse.json({ error: 'Maximum 100 users per batch. Split into multiple requests.' }, { status: 400 });
        }
        if (!certificateData?.title?.trim()) {
            return NextResponse.json({ error: 'Certificate title is required' }, { status: 400 });
        }

        console.log('[bulk-issue] Processing', userIds.length, 'users');

        // Fetch user names in bulk
        const userDocs = await Promise.all(
            userIds.map(uid => db.collection('users').doc(uid).get())
        );
        const userNamesMap: Record<string, string> = {};
        userDocs.forEach((doc, index) => {
            if (doc.exists) {
                const data = doc.data() || {};
                userNamesMap[userIds[index]] = data.displayName || data.name || data.email || 'User';
            }
        });

        // Prepare timestamps
        const issueTs = certificateData.issueDate
            ? admin.firestore.Timestamp.fromDate(new Date(certificateData.issueDate))
            : admin.firestore.Timestamp.now();

        const expiresTs = certificateData.expiresAt
            ? admin.firestore.Timestamp.fromDate(new Date(certificateData.expiresAt))
            : undefined;

        // Process in batches of 500 (Firestore limit)
        const results: IssueResult[] = [];
        const usedCodes = new Set<string>();

        // Use batch writes for efficiency
        const batch = db.batch();
        const publicBatch = db.batch();

        for (const userId of userIds) {
            try {
                const userName = userNamesMap[userId];
                if (!userName) {
                    results.push({ userId, userName: 'Unknown', code: '', success: false, error: 'User not found' });
                    continue;
                }

                // Generate unique code
                let code = generateCode();
                while (usedCodes.has(code)) {
                    code = generateCode();
                }
                usedCodes.add(code);

                // Build certificate document
                const certDoc: Record<string, any> = {
                    userId,
                    userName,
                    title: certificateData.title.trim(),
                    achievement: certificateData.title.trim(), // backward compat
                    code,
                    status: 'issued',
                    issuerId: decoded.uid,
                    issuerName: decoded.name || decoded.email || 'Admin',
                    issueDate: issueTs,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                };

                if (certificateData.description) certDoc.description = certificateData.description;
                if (certificateData.certificateType) certDoc.certificateType = certificateData.certificateType;
                if (certificateData.templateId) certDoc.templateId = certificateData.templateId;
                if (certificateData.templateUrl && /^https?:\/\//i.test(certificateData.templateUrl)) {
                    certDoc.templateUrl = certificateData.templateUrl;
                }
                if (certificateData.issuingAuthority) certDoc.issuingAuthority = certificateData.issuingAuthority;
                if (expiresTs) certDoc.expiresAt = expiresTs;

                // Add to batch
                const certRef = db.collection('certificates').doc();
                batch.set(certRef, certDoc);

                // Public mirror for verification
                const publicDoc = {
                    userName,
                    userId,
                    title: certificateData.title.trim(),
                    achievementTitle: certificateData.title.trim(),
                    issuingAuthority: certificateData.issuingAuthority || decoded.name || 'SEDS Pakistan',
                    issueDate: issueTs,
                    expiresAt: expiresTs || null,
                    certificateCode: code,
                    templateUrl: certDoc.templateUrl || '',
                };
                publicBatch.set(db.collection('certificate_public').doc(code), publicDoc);

                results.push({ userId, userName, code, success: true });
            } catch (err: any) {
                results.push({ userId, userName: userNamesMap[userId] || 'Unknown', code: '', success: false, error: err?.message });
            }
        }

        // Commit batches
        await batch.commit();
        await publicBatch.commit();

        const issued = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        const elapsed = Date.now() - startTime;

        console.log('[bulk-issue] Completed:', { issued, failed, elapsed: `${elapsed}ms` });

        return NextResponse.json({
            ok: true,
            issued,
            failed,
            results,
            elapsed: `${elapsed}ms`,
        });
    } catch (error: any) {
        console.error('[bulk-issue] Error:', error);
        return NextResponse.json({ error: error?.message || 'Bulk issue failed' }, { status: 500 });
    }
}
