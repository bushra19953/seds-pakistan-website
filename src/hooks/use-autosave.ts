import { useEffect, useRef } from 'react';
import { doc, serverTimestamp, getFirestore } from 'firebase/firestore';
;
import { getFirebaseApp } from '@/firebase/provider';
import { setDoc } from '@/lib/client/firestore-wrapper';

export function useAutosave(formState: any, uid: string | undefined) {
  const isFirstRun = useRef(true);
  useEffect(() => {
    console.log('💾 useAutosave - Effect triggered:', {
      hasUid: !!uid,
      formStateKeys: Object.keys(formState || {}),
      formStateEmpty: !formState || Object.keys(formState).length === 0
    });
    
    if (!uid) {
      console.log('⏸️ useAutosave - Skipping: no user ID');
      return;
    }

    // Skip initial autosave to avoid writing immediately on mount/hydration
    if (isFirstRun.current) {
      isFirstRun.current = false;
      console.log('⏭️ useAutosave - Skipping initial autosave on mount');
      return;
    }

    const db = getFirestore(getFirebaseApp());

    console.log('⏰ useAutosave - Setting up autosave timeout for 25 seconds');
    const timeout = setTimeout(async () => {
      try {
        console.log('💾 useAutosave - Starting autosave for user:', uid);
        const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 days from now
        
        const draftData = { 
          payload: formState, 
          updated_at: serverTimestamp(), 
          expires_at: expiresAt 
        };
        
        console.log('📤 useAutosave - Saving draft data:', {
          expiresAt: expiresAt.toISOString(),
          payloadKeys: Object.keys(formState || {})
        });
        
        await setDoc(doc(db, 'drafts', uid), draftData, { merge: true });
        console.log('✅ useAutosave - Draft saved successfully');

      } catch (error) {
        console.error("❌ useAutosave - Error autosaving draft:", error);
      }
    }, 25000); // Autosave every 25 seconds (debounced)

    return () => {
      console.log('🧹 useAutosave - Cleaning up timeout');
      clearTimeout(timeout);
    };
  }, [formState, uid]);
}
