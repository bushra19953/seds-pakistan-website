'use server';

import { getDb } from '@/lib/server/firebase-admin';
import { admin } from '@/lib/server/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import type { CreateChapterApplicationInput, ChapterApplicationStatus } from '@/types/chapter-application';
import { assertConsentFor } from '@/lib/server/consent-gate';
import { ConsentRequiredError } from '@/lib/server/consent-gate-types';
import { bustIdentity } from '@/lib/server/identity-cache';
import {
  mirrorChapterApplicationSet,
  mirrorChapterApplicationUpdate,
  mirrorChapterSet,
  mirrorChapterDelete,
  chapterExistsViaSupa,
} from '@/lib/applications-supa';

// Supabase migration (APPS-1): every write in this file stays on
// Firestore as the primary and is mirrored into the fs_* tables through
// src/lib/applications-supa.ts (flag-gated, never throws). The approval
// path's chapters CREATE goes through the seam's ChaptersWriterPort —
// a local interface for APPS-3's src/lib/chapters-supa.ts (flagged
// cross-seam dependency). Touches of OTHER collections in this file
// stay on Firestore only and are flagged inline: users, warningConfig,
// audit_logs, orders.

// ---------------------------------------------------------------------------
// Create a new chapter application (called from register-chapter page)
// ---------------------------------------------------------------------------
export async function createChapterApplication(
  input: CreateChapterApplicationInput
): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error('Database connection failed');

    if (!input.applicantId) throw new Error('Unauthorized: User ID required');

    // 🛑 ENFORCEMENT CHECK: Block blacklisted users
    // CROSS-CLUSTER (flagged): the users read and the warningConfig read
    // belong to other clusters; both stay on Firestore.
    const [userSnap, configSnap] = await Promise.all([
      db.collection('users').doc(input.applicantId).get(),
      db.collection('warningConfig').doc('global').get()
    ]);

    const userData = userSnap.data() || {};
    const configData = configSnap.data() || { enforcementEnabled: true };

    if (configData.enforcementEnabled && userData.isBlacklisted === true) {
      throw new Error('Action Blocked: Your account is currently blacklisted. Chapter applications are restricted.');
    }

    if (!input.universityName || !input.proposedChapterName) {
      throw new Error('University name and proposed chapter name are required');
    }
    if (!input.teamMembers || input.teamMembers.length < 5) {
      throw new Error('At least 5 team members are required');
    }
    if (!input.facultyAdvisor?.name || !input.facultyAdvisor?.email) {
      throw new Error('Faculty advisor name and email are required');
    }

    // Prevent duplicate applications from same user
    const existing = await db.collection('chapter_applications')
      .where('applicantId', '==', input.applicantId)
      .where('status', 'in', ['pending_payment', 'pending_review', 'under_review', 'info_requested'])
      .limit(1)
      .get();

    if (!existing.empty) {
      return { success: false, error: 'You already have an active chapter application. Check your profile for status updates.' };
    }

    const applicationData = {
      ...input,
      status: 'pending_payment' as ChapterApplicationStatus,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const ref = await db.collection('chapter_applications').add(applicationData);

    // Dual-write mirror into fs_chapter_applications (same doc id).
    await mirrorChapterApplicationSet(ref.id, applicationData);

    // Audit log
    // CROSS-CLUSTER (flagged): audit_logs belongs to another cluster;
    // this write stays on Firestore.
    await db.collection('audit_logs').add({
      action: 'CHAPTER_APPLICATION_CREATED',
      actorUid: input.applicantId,
      targetUidOrResource: ref.id,
      payload: {
        universityName: input.universityName,
        proposedChapterName: input.proposedChapterName,
        teamSize: input.teamMembers.length,
      },
      timestamp: FieldValue.serverTimestamp(),
      source: 'server-action',
    });

    return { success: true, id: ref.id };
  } catch (error: any) {
    console.error('[chapter-applications] Create failed:', error);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Mark application as paid (called after checkout creates the order)
// ---------------------------------------------------------------------------
export async function linkOrderToApplication(
  applicationId: string,
  orderId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error('Database connection failed');

    const linkPayload = {
      status: 'pending_review',
      orderId,
      updatedAt: FieldValue.serverTimestamp(),
    };
    await db.collection('chapter_applications').doc(applicationId).update(linkPayload);

    // Dual-write mirror into fs_chapter_applications.
    await mirrorChapterApplicationUpdate(applicationId, linkPayload);

    return { success: true };
  } catch (error: any) {
    console.error('[chapter-applications] Link order failed:', error);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Admin: update application status (approve, reject, request info)
// ---------------------------------------------------------------------------
export async function updateChapterApplicationStatus(
  applicationId: string,
  status: ChapterApplicationStatus,
  adminUid: string,
  extra?: { rejectionReason?: string; adminNotes?: string; infoRequestMessage?: string },
  opts?: { consentRequestId?: string | null }
): Promise<{ success: boolean; chapterId?: string; error?: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error('Database connection failed');

    const appRef = db.collection('chapter_applications').doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) throw new Error('Application not found');

    const appData = appSnap.data()!;

    // Phase 2 consent gate (spec B.3b.2): approval admits a chapter - a
    // Reserved Matter. The gate lives INSIDE the action so every caller
    // (this route and any future caller) inherits it, and it runs BEFORE
    // any side effect: a block leaves the application status untouched, no
    // chapter doc, no user chapterId writes, no order mutation. Only the
    // 'approved' transition is gated; rejections, info requests, and
    // under-review moves are national-team judgement calls.
    if (status === 'approved') {
      await assertConsentFor({
        db,
        actorUid: adminUid,
        matterKey: 'chapter_lifecycle',
        consentRequestId: opts?.consentRequestId ?? null,
        subjectRef: { type: 'chapter_application', applicationId, action: 'admit' },
        actSummary: `Admit chapter from application ${applicationId} (${appData.proposedChapterName ?? 'unnamed'})`,
      });
    }

    const updatePayload: Record<string, any> = {
      status,
      reviewedBy: adminUid,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (extra?.rejectionReason) updatePayload.rejectionReason = extra.rejectionReason;
    if (extra?.adminNotes) updatePayload.adminNotes = extra.adminNotes;
    if (extra?.infoRequestMessage) updatePayload.infoRequestMessage = extra.infoRequestMessage;

    let createdChapterId: string | undefined;

    // On approval: auto-create the chapter record + associate team members
    if (status === 'approved') {
      const slug = appData.proposedChapterName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      // Use slug as document ID (matches existing admin pattern)
      // If slug already taken, append a suffix
      let finalSlug = slug;
      // CROSS-SEAM (flagged): the chapters collection is owned by
      // APPS-3 (seam src/lib/chapters-supa.ts). The existence check
      // goes through the local ChaptersWriterPort in
      // src/lib/applications-supa.ts when Supa is live for this
      // surface; null means unavailable/errored and the Firestore
      // check runs unchanged.
      const supaSlugTaken = await chapterExistsViaSupa(slug);
      let slugTaken: boolean;
      if (supaSlugTaken !== null) {
        slugTaken = supaSlugTaken;
      } else {
        const existingChapter = await db.collection('chapters').doc(slug).get();
        slugTaken = existingChapter.exists;
      }
      if (slugTaken) {
        finalSlug = `${slug}-${Date.now().toString(36)}`;
      }

      const chapterData = {
        name: appData.proposedChapterName,
        slug: finalSlug,
        city: appData.city || '',
        country: appData.country || '',
        universityName: appData.universityName,
        isActive: true,
        applicationId,
        foundedBy: appData.applicantId,
        teamMembers: appData.teamMembers || [],
        facultyAdvisor: appData.facultyAdvisor || null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      await db.collection('chapters').doc(finalSlug).set(chapterData);
      // CROSS-SEAM (flagged): mirror the chapters create through the
      // ChaptersWriterPort (APPS-3 seam) — never the raw adapter.
      await mirrorChapterSet(finalSlug, chapterData);
      createdChapterId = finalSlug;
      updatePayload.createdChapterId = createdChapterId;

      // Associate founding team members with the chapter
      // CROSS-CLUSTER (flagged): the users chapterId writes below
      // belong to the users/identity cluster; they stay on Firestore.
      // 1. Set chapterId on the applicant (founder)
      await db.collection('users').doc(appData.applicantId).update({
        chapterId: createdChapterId,
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(e => console.warn(`[chapter-approval] Could not update founder ${appData.applicantId}:`, e));
      // Read-Burn A (§2.5 W19): the applicant's chapterId was set
      // above; bust their identity bundle. Harmless if the
      // .catch-swallowed update actually failed (only forces a reload).
      bustIdentity(appData.applicantId);

      // 2. Find team members by email and update their chapterId
      const teamEmails = (appData.teamMembers || [])
        .map((m: any) => m.email?.toLowerCase())
        .filter((e: string) => e && e !== appData.applicantEmail?.toLowerCase());

      if (teamEmails.length > 0) {
        // Firestore 'in' queries support max 30 values, batch if needed
        for (let i = 0; i < teamEmails.length; i += 30) {
          const batch = teamEmails.slice(i, i + 30);
          const usersSnap = await db.collection('users')
            .where('email', 'in', batch)
            .get();

          const chunkUserIds = usersSnap.docs.map(doc => doc.id);
          const writeBatch = db.batch();
          usersSnap.docs.forEach(doc => {
            writeBatch.update(doc.ref, {
              chapterId: createdChapterId,
              updatedAt: FieldValue.serverTimestamp(),
            });
          });
          await writeBatch.commit();
          // Read-Burn A (§2.5 W19): bust this chunk's team members
          // after this chunk's commit, using the ids collected from
          // this chunk's usersSnap.docs before committing.
          for (const teamUserId of chunkUserIds) {
            bustIdentity(teamUserId);
          }
          console.log(`[chapter-approval] Updated ${usersSnap.docs.length} team members' chapterId to ${createdChapterId}`);
        }
      }

      // Update the order status to delivered if it exists
      // CROSS-CLUSTER (flagged): orders belongs to the finance/store
      // cluster; this write stays on Firestore.
      if (appData.orderId) {
        await db.collection('orders').doc(appData.orderId).update({
          status: 'delivered',
          paymentStatus: 'completed',
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    await appRef.update(updatePayload);

    // Dual-write mirror into fs_chapter_applications.
    await mirrorChapterApplicationUpdate(applicationId, updatePayload);

    // Audit log
    // CROSS-CLUSTER (flagged): audit_logs belongs to another cluster;
    // this write stays on Firestore.
    await db.collection('audit_logs').add({
      action: `CHAPTER_APPLICATION_${status.toUpperCase()}`,
      actorUid: adminUid,
      targetUidOrResource: applicationId,
      payload: {
        newStatus: status,
        createdChapterId,
        rejectionReason: extra?.rejectionReason,
        consentRequestId: status === 'approved' ? (opts?.consentRequestId ?? null) : null,
      },
      timestamp: FieldValue.serverTimestamp(),
      source: 'server-action',
    });

    return { success: true, chapterId: createdChapterId };
  } catch (error: any) {
    // A consent-gate block is not a generic failure: it must reach the route
    // as the typed 409 body, never flattened into { success: false }.
    if (error instanceof ConsentRequiredError) throw error;
    console.error('[chapter-applications] Status update failed:', error);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Delete chapter with full cleanup (chapter doc + user associations + application revert)
// ---------------------------------------------------------------------------
export async function deleteChapterWithCleanup(
  chapterId: string,
  adminUid: string,
  opts?: { consentRequestId?: string | null }
): Promise<{ success: boolean; usersUpdated: number; error?: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error('Database connection failed');

    const chapterRef = db.collection('chapters').doc(chapterId);
    const chapterSnap = await chapterRef.get();
    if (!chapterSnap.exists) throw new Error('Chapter not found');

    const chapterData = chapterSnap.data()!;

    // Phase 2 consent gate (spec B.3b.3): chapter deletion is expulsion by
    // another route - the most destructive chapter act there is, and it was
    // previously guarded by nothing but canManageChapterApplications. The
    // gate runs inside the action, before any cleanup step.
    await assertConsentFor({
      db,
      actorUid: adminUid,
      matterKey: 'chapter_lifecycle',
      consentRequestId: opts?.consentRequestId ?? null,
      subjectRef: { type: 'chapter', chapterId, action: 'delete' },
      actSummary: `Delete chapter ${chapterId} (${chapterData.name ?? 'unnamed'}) with cleanup`,
    });

    let usersUpdated = 0;

    // 1. Remove chapterId from ALL users who belong to this chapter
    //    CROSS-CLUSTER (flagged): these users writes belong to the
    //    users/identity cluster; they stay on Firestore.
    //    Process in batches of 500 (Firestore batch limit)
    let hasMore = true;
    while (hasMore) {
      const usersSnap = await db.collection('users')
        .where('chapterId', '==', chapterId)
        .limit(500)
        .get();

      if (usersSnap.empty) {
        hasMore = false;
        break;
      }

      const batch = db.batch();
      usersSnap.docs.forEach(doc => {
        batch.update(doc.ref, {
          chapterId: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
      usersUpdated += usersSnap.docs.length;

      // If we got fewer than 500, we're done
      if (usersSnap.docs.length < 500) hasMore = false;
    }

    // 2. Revert the associated chapter application (if any) back to rejected
    if (chapterData.applicationId) {
      const revertPayload = {
        status: 'rejected',
        createdChapterId: FieldValue.delete(),
        adminNotes: `Chapter deleted by admin. ${usersUpdated} user(s) disassociated.`,
        reviewedBy: adminUid,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      await db.collection('chapter_applications').doc(chapterData.applicationId).update(revertPayload)
        .catch(e => console.warn('[deleteChapter] Could not revert application:', e));
      // Dual-write mirror into fs_chapter_applications (the seam's
      // serializer turns FieldValue.delete() into a key removal).
      await mirrorChapterApplicationUpdate(chapterData.applicationId, revertPayload);
    }

    // 3. Delete the chapter document
    await chapterRef.delete();
    // CROSS-SEAM (flagged): mirror the chapters delete through the
    // ChaptersWriterPort (APPS-3 seam).
    await mirrorChapterDelete(chapterId);

    // 4. Audit log
    // CROSS-CLUSTER (flagged): audit_logs belongs to another cluster;
    // this write stays on Firestore.
    await db.collection('audit_logs').add({
      action: 'CHAPTER_DELETED_WITH_CLEANUP',
      actorUid: adminUid,
      targetUidOrResource: chapterId,
      payload: {
        chapterName: chapterData.name,
        usersUpdated,
        applicationReverted: chapterData.applicationId || null,
      },
      timestamp: FieldValue.serverTimestamp(),
      source: 'server-action',
    });

    console.log(`[deleteChapter] Deleted chapter ${chapterId}, updated ${usersUpdated} users`);
    return { success: true, usersUpdated };
  } catch (error: any) {
    if (error instanceof ConsentRequiredError) throw error;
    console.error('[deleteChapter] Cleanup failed:', error);
    return { success: false, usersUpdated: 0, error: error.message };
  }
}
