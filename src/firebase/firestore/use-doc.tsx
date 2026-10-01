'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  onSnapshot,
  DocumentReference,
  DocumentData,
  getDoc,
  DocumentSnapshot,
} from 'firebase/firestore';
import { errorEmitter } from '../error-emitter';
import { FirestorePermissionError } from '../errors';
import { handleFirestoreError, FirestoreErrorContext } from '../error-handler';

interface UseDocReturn<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export function useDoc<T extends DocumentData>(
  docRef: DocumentReference<T> | null,
  options: { listen: boolean } = { listen: false }
): UseDocReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Stabilize the options object to prevent infinite loops
  const stableOptions = useMemo(() => options, [JSON.stringify(options)]);

  useEffect(() => {
    if (!docRef) {
      setLoading(false);
      return;
    }
    setLoading(true);

    if (stableOptions.listen) {
      const unsubscribe = onSnapshot(
        docRef,
        (snapshot: DocumentSnapshot<T>) => {
          if (snapshot.exists()) {
            setData({ ...snapshot.data(), id: snapshot.id } as T);
          } else {
            setData(null);
          }
          setLoading(false);
        },
        (err) => {
          const errorContext: FirestoreErrorContext = {
            operation: 'get',
            collection: docRef.path.split('/')[0],
            documentId: docRef.id,
            additionalContext: { listen: true }
          };
          
          const handledError = handleFirestoreError(err, {
            context: errorContext,
            showUserFriendlyMessages: false
          });
          
          setError(handledError);
          setLoading(false);
        }
      );
      return () => unsubscribe();
    } else {
      getDoc(docRef)
        .then((snapshot) => {
          if (snapshot.exists()) {
            setData({ ...snapshot.data(), id: snapshot.id } as T);
          } else {
            setData(null);
          }
          setLoading(false);
        })
        .catch((err) => {
          const errorContext: FirestoreErrorContext = {
            operation: 'get',
            collection: docRef.path.split('/')[0],
            documentId: docRef.id,
            additionalContext: { listen: false }
          };
          
          const handledError = handleFirestoreError(err, {
            context: errorContext,
            showUserFriendlyMessages: false
          });
          
          setError(handledError);
          setLoading(false);
        });
    }
  }, [docRef, stableOptions.listen]);

  return { data, loading, error };
}
