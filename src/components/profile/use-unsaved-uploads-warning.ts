'use client';

import { useEffect } from 'react';

/**
 * Warns the user before they close or navigate away while freshly uploaded
 * files have not been submitted yet. Uploading alone does NOT attach the
 * file to the task (submit flow); without this warning users orphan files
 * in Drive by leaving the page after the green checkmark appears.
 */
export function useUnsavedUploadsWarning(hasUnsaved: boolean) {
  useEffect(() => {
    if (!hasUnsaved) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsaved]);
}
