import { useEffect, useRef } from 'react';
import { serverWrite } from '@/lib/client/server-write';

const DEBOUNCE_MS = 4000;

export function useAutosave(formState: any, uid: string | undefined) {
  const isFirstRun = useRef(true);
  const pendingRef = useRef<{ state: any; uid: string } | null>(null);

  const flushDraft = async (state: any, draftUid: string) => {
    try {
      // WS10: routed through POST /api/autosave — the route owns the
      // drafts/{uid} doc (the uid argument is retained for the hook's
      // API; the route addresses the caller's own draft from the
      // verified token) and stamps updated_at / expires_at (+30d)
      // server-side in the exact stored shape this hook used.
      void draftUid;
      await serverWrite('/api/autosave', 'POST', { state });
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
