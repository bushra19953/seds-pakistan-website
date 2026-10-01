'use server';

import { getDb } from '@/lib/server/firebase-admin';
import { admin } from '@/lib/server/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import type { CreateChapterApplicationInput, ChapterApplicationStatus } from '@/types/chapter-application';

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

    // Audit log
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

    await db.collection('chapter_applications').doc(applicationId).update({
      status: 'pending_review',
      orderId,
      updatedAt: FieldValue.serverTimestamp(),
    });

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
  extra?: { rejectionReason?: string; adminNotes?: string; infoRequestMessage?: string }
): Promise<{ success: boolean; chapterId?: string; error?: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error('Database connection failed');

    const appRef = db.collection('chapter_applications').doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) throw new Error('Application not found');

    const appData = appSnap.data()!;

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
      const existingChapter = await db.collection('chapters').doc(slug).get();
      if (existingChapter.exists) {
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
      createdChapterId = finalSlug;
      updatePayload.createdChapterId = createdChapterId;

      // Associate founding team members with the chapter
      // 1. Set chapterId on the applicant (founder)
      await db.collection('users').doc(appData.applicantId).update({
        chapterId: createdChapterId,
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(e => console.warn(`[chapter-approval] Could not update founder ${appData.applicantId}:`, e));

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

          const writeBatch = db.batch();
          usersSnap.docs.forEach(doc => {
            writeBatch.update(doc.ref, {
              chapterId: createdChapterId,
              updatedAt: FieldValue.serverTimestamp(),
            });
          });
          await writeBatch.commit();
          console.log(`[chapter-approval] Updated ${usersSnap.docs.length} team members' chapterId to ${createdChapterId}`);
        }
      }

      // Update the order status to delivered if it exists
      if (appData.orderId) {
        await db.collection('orders').doc(appData.orderId).update({
          status: 'delivered',
          paymentStatus: 'completed',
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    await appRef.update(updatePayload);

    // Audit log
    await db.collection('audit_logs').add({
      action: `CHAPTER_APPLICATION_${status.toUpperCase()}`,
      actorUid: adminUid,
      targetUidOrResource: applicationId,
      payload: {
        newStatus: status,
        createdChapterId,
        rejectionReason: extra?.rejectionReason,
      },
      timestamp: FieldValue.serverTimestamp(),
      source: 'server-action',
    });

    return { success: true, chapterId: createdChapterId };
  } catch (error: any) {
    console.error('[chapter-applications] Status update failed:', error);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Delete chapter with full cleanup (chapter doc + user associations + application revert)
// ---------------------------------------------------------------------------
export async function deleteChapterWithCleanup(
  chapterId: string,
  adminUid: string
): Promise<{ success: boolean; usersUpdated: number; error?: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error('Database connection failed');

    const chapterRef = db.collection('chapters').doc(chapterId);
    const chapterSnap = await chapterRef.get();
    if (!chapterSnap.exists) throw new Error('Chapter not found');

    const chapterData = chapterSnap.data()!;
    let usersUpdated = 0;

    // 1. Remove chapterId from ALL users who belong to this chapter
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
      await db.collection('chapter_applications').doc(chapterData.applicationId).update({
        status: 'rejected',
        createdChapterId: FieldValue.delete(),
        adminNotes: `Chapter deleted by admin. ${usersUpdated} user(s) disassociated.`,
        reviewedBy: adminUid,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(e => console.warn('[deleteChapter] Could not revert application:', e));
    }

    // 3. Delete the chapter document
    await chapterRef.delete();

    // 4. Audit log
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
    console.error('[deleteChapter] Cleanup failed:', error);
    return { success: false, usersUpdated: 0, error: error.message };
  }
}
