'use client';

import { useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';

// This component is currently not used, but can be re-added to the layout if needed.
export function FirebaseErrorListener() {
  const { toast } = useToast();

  useEffect(() => {
    const handleError = (error: FirestorePermissionError) => {
      console.error('Caught Firestore Permission Error:', error);
      
      const isDev = process.env.NODE_ENV === 'development';
      
      // Skip showing toast for certain expected permission errors during loading
      const skipToast = error.message?.includes('roles') || error.message?.includes('role');
      
      if (!skipToast) {
        toast({
          variant: 'destructive',
          title: 'Permission Denied',
          description: isDev ? error.message : 'You do not have permission to perform this action.',
          duration: isDev ? 20000 : 5000,
        });
      }
    };

    errorEmitter.on('permission-error', handleError);

    return () => {
      errorEmitter.off('permission-error', handleError);
    };
  }, [toast]);

  return null;
}
