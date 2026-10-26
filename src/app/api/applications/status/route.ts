/**
 * Applicant Status Portal API (Workstream 4, spec section 3).
 *
 * Why this route exists: Firestore rules deny applicants any read on the
 * `applications` collection (only admins and executives can read it), and
 * the owner-update rule locks any owner write to status 'pending'. The
 * portal therefore goes through the Admin SDK here, where every access is
 * scoped server-side:
 *
 * - GET   (Bearer ID token): the signed-in applicant's own application,
 *         looked up strictly by the token UID (the doc id). Nobody can
 *         read anyone else's application through this route.
 * - POST  (public): lookup by application reference ID + email. BOTH must
 *         match the same document. Any mismatch returns the same generic
 *         404, so the endpoint cannot be used as an oracle for which
 *         emails or reference IDs exist.
 * - PATCH (Bearer ID token): self-service updates to the caller's own
 *         application only. The writable surface is a strict whitelist
 *         (document links, domain preferences, onboarding milestones);
 *         status and admin review fields can never be touched here.
 *
 * Responses are the sanitized payload from src/lib/applicant-status.ts:
 * dynamic form answers and review internals never leave the server.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  identityPrimaryFlagOn,
  primaryIdentitySet,
  primaryIdentityUpdate,
} from '@/lib/server/supa-identity-primary';

import { admin, getDb, ensureAdminInitialized } from '@/lib/server/firebase-admin';
import {
  buildCadetshipPayload,
  buildStatusPayload,
  makeReferenceId,
  milestonesUnlocked,
  normalizeReferenceId,
  validateDocumentUpdate,
  validateDomainPreferences,
  validateMilestoneUpdate,
  type ApplicationRecord,
  type CadetshipTrackerPayload,
} from '@/lib/applicant-status';
import {
  resolveApplicationsSupaAdapter,
  getApplicationRecord,
  findApplicationDocsByEmail,
  tryListCadetshipsForPerson,
  mirrorApplicationUpdate,
  applicationsPrimaryActive,
  updateApplicationPrimaryFirst,
} from '@/lib/applications-supa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Db = NonNullable<ReturnType<typeof getDb>>;

function serverTimestamp(): unknown {
  return admin.firestore.FieldValue.serverTimestamp();
}

async function verifyCaller(request: NextRequest): Promise<{ uid: string } | null> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;
  if (!ensureAdminInitialized()) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return { uid: decoded.uid };
  } catch {
    return null;
  }
}

async function loadPayload(
  db: Db,
  uid: string,
  canEdit: boolean,
  opts?: { firestore?: boolean }
): Promise<ReturnType<typeof buildStatusPayload> | null> {
  // Supa read path (flag-gated seam): flag OFF / adapter unavailable /
  // adapter error all land on the Firestore read below, unchanged. The
  // PATCH handler passes { firestore: true } for its post-write read:
  // the primary write just landed on Firestore, and the fs mirror is a
  // read copy that may lag or have failed (the mirror result is logged
  // by the seam), so the freshest correct read is the primary.
  let record: ApplicationRecord | null = null;
  if (!opts?.firestore) {
    const supaAdapter = await resolveApplicationsSupaAdapter();
    if (supaAdapter) {
      try {
        const supaRecord = await getApplicationRecord(supaAdapter, uid);
        if (!supaRecord) return null;
        record = supaRecord as ApplicationRecord;
      } catch (supaErr) {
        console.error('[applications/status] Supa application read failed, falling back to Firestore:', supaErr);
        record = null;
      }
    }
  }
  if (!record) {
    const snap = await db.collection('applications').doc(uid).get();
    if (!snap.exists) return null;
    record = (snap.data() ?? {}) as ApplicationRecord;
  }

  // A resubmission replaces the application doc wholesale (batch.set
  // without merge in the induction submit), which would wipe portal-saved
  // domain preferences. PATCH mirrors them onto users/{uid}; read the
  // mirror back here as a fallback.
  let fallbackDomainPreferences: unknown;
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    fallbackDomainPreferences = userSnap.exists ? userSnap.data()?.domainPreferences : undefined;
  } catch {
    fallbackDomainPreferences = undefined;
  }

  // Phase 2 F.7: attach the cadetship block when a cadetship record
  // exists for this applicant. A failed lookup degrades to no block -
  // the rest of the tracker must never break because of it - and an
  // approved applicant without one is flagged legacyApproved by
  // buildStatusPayload (their portal renders exactly as before).
  let cadetship: CadetshipTrackerPayload | null = null;
  try {
    // Cadetships are read through the APPS-4 seam port declared in
    // src/lib/applications-supa.ts (local interface; APPS-4 owns
    // src/lib/cadetships-supa.ts). A null result means Supa is
    // unavailable or errored for this surface, and the Firestore lookup
    // below runs exactly as before.
    const supaCadetDocs = await tryListCadetshipsForPerson(uid, 5);
    if (supaCadetDocs !== null) {
      if (supaCadetDocs.length > 0) {
        const docs = [...supaCadetDocs].sort((a, b) => {
          const ta = a.startedAt as { toMillis?: () => number } | undefined;
          const tb = b.startedAt as { toMillis?: () => number } | undefined;
          const ma = typeof ta?.toMillis === 'function' ? ta.toMillis() : 0;
          const mb = typeof tb?.toMillis === 'function' ? tb.toMillis() : 0;
          return mb - ma;
        });
        cadetship = buildCadetshipPayload(docs[0], new Date());
      }
    } else {
      const cadetSnap = await db
        .collection('cadetships')
        .where('personUid', '==', uid)
        .limit(5)
        .get();
      if (!cadetSnap.empty) {
        const docs = cadetSnap.docs
          .map((d) => d.data() as Record<string, unknown>)
          .sort((a, b) => {
            const ta = a.startedAt as { toMillis?: () => number } | undefined;
            const tb = b.startedAt as { toMillis?: () => number } | undefined;
            const ma = typeof ta?.toMillis === 'function' ? ta.toMillis() : 0;
            const mb = typeof tb?.toMillis === 'function' ? tb.toMillis() : 0;
            return mb - ma;
          });
        cadetship = buildCadetshipPayload(docs[0], new Date());
      }
    }
  } catch {
    cadetship = null;
  }

  return buildStatusPayload(record, uid, { canEdit, fallbackDomainPreferences, cadetship });
}

// GET: signed-in applicant reads their own application status.
export async function GET(request: NextRequest) {
  try {
    const caller = await verifyCaller(request);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

    const payload = await loadPayload(db, caller.uid, true);
    if (!payload) {
      return NextResponse.json({ error: 'No application found for this account.' }, { status: 404 });
    }
    return NextResponse.json({ application: payload });
  } catch (err: any) {
    console.error('[applications/status] GET error:', err);
    return NextResponse.json({ error: 'Could not load application status.' }, { status: 500 });
  }
}

// POST: public lookup by reference ID + email. Both must match one doc.
export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

    const body = await request.json().catch(() => null);
    const referenceId = normalizeReferenceId(body?.referenceId);
    const emailInput = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!referenceId || !emailInput || !emailInput.includes('@')) {
      return NextResponse.json(
        { error: 'Enter your application reference ID and the email you applied with.' },
        { status: 400 }
      );
    }

    // Emails are stored exactly as they came from the auth session. Try
    // the trimmed input first, then its lowercase form; both share the
    // same generic failure below, so no oracle is created either way.
    const candidates = emailInput === emailInput.toLowerCase()
      ? [emailInput]
      : [emailInput, emailInput.toLowerCase()];
    let candidateDocs: Array<{ id: string }> = [];
    // Supa read path (flag-gated seam): same email query (limit 5)
    // against fs_applications; flag OFF / adapter unavailable / adapter
    // error runs the Firestore query below, unchanged.
    const supaAdapter = await resolveApplicationsSupaAdapter();
    for (const email of candidates) {
      let docs: Array<{ id: string }> | null = null;
      if (supaAdapter) {
        try {
          docs = (await findApplicationDocsByEmail(supaAdapter, email)) as Array<{ id: string }>;
        } catch (supaErr) {
          console.error('[applications/status] Supa email lookup failed, falling back to Firestore:', supaErr);
          docs = null;
        }
      }
      if (docs === null) {
        const snap = await db.collection('applications').where('email', '==', email).limit(5).get();
        docs = snap.empty ? [] : snap.docs;
      }
      if (docs.length > 0) {
        candidateDocs = docs;
        break;
      }
    }

    let matchedUid: string | null = null;
    for (const docSnap of candidateDocs) {
      if (makeReferenceId(docSnap.id) === referenceId) {
        matchedUid = docSnap.id;
        break;
      }
    }

    // One generic failure for every mismatch: no oracle distinguishing a
    // wrong email from a wrong reference ID.
    if (!matchedUid) {
      return NextResponse.json(
        { error: 'No application matches that reference ID and email.' },
        { status: 404 }
      );
    }

    const payload = await loadPayload(db, matchedUid, false);
    if (!payload) {
      return NextResponse.json(
        { error: 'No application matches that reference ID and email.' },
        { status: 404 }
      );
    }
    return NextResponse.json({ application: payload });
  } catch (err: any) {
    console.error('[applications/status] POST error:', err);
    return NextResponse.json({ error: 'Could not look up the application.' }, { status: 500 });
  }
}

// PATCH: signed-in applicant updates their own whitelisted fields.
export async function PATCH(request: NextRequest) {
  try {
    const caller = await verifyCaller(request);
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    if (!db) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be an object.' }, { status: 400 });
    }
    const allowedSections = new Set(['documents', 'domainPreferences', 'milestones']);
    for (const key of Object.keys(body)) {
      if (!allowedSections.has(key)) {
        return NextResponse.json({ error: `Field cannot be updated here: ${key}` }, { status: 400 });
      }
    }

    const appRef = db.collection('applications').doc(caller.uid);
    // Write primacy (cutover): the pre-write read comes from the primary
    // store. A missing fs row is authoritative (404, same body); an
    // adapter error propagates to the route catch as a loud 500 — never
    // a silent Firestore fallback on a primary write flow.
    let record: ApplicationRecord | null = null;
    if (await applicationsPrimaryActive()) {
      const adapter = await resolveApplicationsSupaAdapter();
      const primaryRecord = adapter ? await getApplicationRecord(adapter, caller.uid) : null;
      if (!primaryRecord) {
        return NextResponse.json({ error: 'No application found for this account.' }, { status: 404 });
      }
      record = primaryRecord as ApplicationRecord;
    } else {
      const snap = await appRef.get();
      if (!snap.exists) {
        return NextResponse.json({ error: 'No application found for this account.' }, { status: 404 });
      }
      record = (snap.data() ?? {}) as ApplicationRecord;
    }
    const currentStatus = typeof record.status === 'string' ? record.status.toLowerCase() : 'pending';

    const update: Record<string, unknown> = { updated_at: serverTimestamp() };
    let usersMirror: Record<string, unknown> | null = null;

    if ('documents' in body) {
      const result = validateDocumentUpdate(body.documents);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
      Object.assign(update, result.value);
      // Keep the legacy form field in sync: the induction form writes
      // resumeUpload and mirrors it to resume_url at submit time.
      if ('resume_url' in result.value) update.resumeUpload = result.value.resume_url;
    }

    if ('domainPreferences' in body) {
      const result = validateDomainPreferences(body.domainPreferences);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
      update.domainPreferences = result.value;
      usersMirror = { domainPreferences: result.value, updatedAt: serverTimestamp() };
    }

    if ('milestones' in body) {
      if (!milestonesUnlocked(currentStatus)) {
        return NextResponse.json(
          { error: 'The onboarding checklist unlocks once your application is shortlisted.' },
          { status: 403 }
        );
      }
      const result = validateMilestoneUpdate(body.milestones);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
      for (const [key, done] of Object.entries(result.value)) {
        // Dot-path update so toggling one milestone never rewrites the
        // rest of the map (or racing admin stage stamps).
        update[`onboardingMilestones.${key}`] = done ? serverTimestamp() : null;
      }
    }

    // Write primacy (cutover): the adapter write lands FIRST and throws
    // on failure (the route catch returns 500; nothing is written to
    // Firestore). Firestore then receives the same update as the
    // post-commit mirror, best-effort. Without primacy this is exactly
    // the pre-cutover flow: Firestore update, then the never-throwing
    // dual-write mirror.
    const primaryWritten = await updateApplicationPrimaryFirst(caller.uid, update);
    if (primaryWritten) {
      try {
        await appRef.update(update);
      } catch (mirrorErr) {
        console.error('[applications/status] Firestore mirror update failed after primary write:', mirrorErr);
      }
    } else {
      await appRef.update(update);
      await mirrorApplicationUpdate(caller.uid, update);
    }
    if (usersMirror) {
      // WRITE PRIMACY (identity full build, G-USER-1, U-13): under
      // isSupaPrimary('users') the users mirror lands on the adapter
      // FIRST (loud); the Firestore set becomes the best-effort
      // reverse mirror. Non-primary: Firestore exactly as today.
      if (await identityPrimaryFlagOn('users')) {
        await primaryIdentitySet('users', 'users', caller.uid, usersMirror, { merge: true });
        try {
          await db.collection('users').doc(caller.uid).set(usersMirror, { merge: true });
        } catch (mirrorErr) {
          console.error('[applications/status] Firestore reverse mirror (users domainPreferences) failed after Supa primary commit:', mirrorErr);
        }
      } else {
        await db.collection('users').doc(caller.uid).set(usersMirror, { merge: true });
      }
    }

    // Post-write read: from Firestore in dual-write (the primary just
    // landed there and the fs mirror may lag — the original reasoning);
    // under write primacy the primary store holds the fresh state, so
    // the normal Supa-first read path serves it.
    const payload = await loadPayload(db, caller.uid, true, { firestore: !primaryWritten });
    return NextResponse.json({ application: payload });
  } catch (err: any) {
    console.error('[applications/status] PATCH error:', err);
    return NextResponse.json({ error: 'Could not save your changes.' }, { status: 500 });
  }
}
