import { useEffect, useRef } from 'react';
import { doc, serverTimestamp, getFirestore } from 'firebase/firestore';
import { getFirebaseApp } from '@/firebase/provider';
import { setDoc } from '@/lib/client/firestore-wrapper';

const DEBOUNCE_MS = 4000;
const DRAFT_TTL_DAYS = 30;

export function useAutosave(formState: any, uid: string | undefined) {
  const isFirstRun = useRef(true);
  const pendingRef = useRef<{ state: any; uid: string } | null>(null);

  const flushDraft = async (state: any, draftUid: string) => {
    try {
      const db = getFirestore(getFirebaseApp());
      const expiresAt = new Date(Date.now() + DRAFT_TTL_DAYS * 24 * 3600 * 1000);
      await setDoc(
        doc(db, 'drafts', draftUid),
        {
          payload: state,
          updated_at: serverTimestamp(),
          expires_at: expiresAt,
        },
        { merge: true }
      );
      pendingRef.current = null;
    } catch (error) {
      console.error("useAutosave - Error autosaving draft:", error);
    }
  };

  useEffect(() => {
    if (!uid) {
      pendingRef.current = null;
      return;
    }

    // Skip initial autosave to avoid writing immediately on mount/hydration
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }

    // Track the latest pending state so a page unload can flush it
    pendingRef.current = { state: formState, uid };

    const timeout = setTimeout(() => {
      void flushDraft(formState, uid);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
    };
  }, [formState, uid]);

  // Flush any pending draft when the page is hidden or closed, so
  // closing the tab mid-typing does not lose unsaved data
  useEffect(() => {
    const flush = () => {
      const pending = pendingRef.current;
      if (pending) {
        void flushDraft(pending.state, pending.uid);
      }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);
}
