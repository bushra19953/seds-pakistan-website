'use client';

import { useState, useEffect } from 'react';
import { useRef } from 'react';
import {
  onSnapshot,
  Query,
  DocumentData,
  collection,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  getDocs,
  endBefore,
  limitToLast,
  QuerySnapshot,
} from 'firebase/firestore';
import { errorEmitter } from '../error-emitter';
import { FirestorePermissionError } from '../errors';
import { handleFirestoreError, FirestoreErrorContext } from '../error-handler';

type CollectionData<T> = T[];

interface UseCollectionReturn<T> {
  data: CollectionData<T> | null;
  loading: boolean;
  error: Error | null;
}

export function useCollection<T extends DocumentData>(
  query: Query<T> | null,
  options: { listen: boolean } = { listen: false }
): UseCollectionReturn<T> {
  const [data, setData] = useState<CollectionData<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const prevQueryRef = useRef<Query<T> | null>(null);
  const inFlightRef = useRef<boolean>(false);
  const lastErrorAtRef = useRef<number>(0);
  const lastLogAtRef = useRef<number>(0);
  const errorCooldownMs = 60000;
  const logCooldownMs = 5000;
  const retryCountRef = useRef<number>(0);
  const retryTimerRef = useRef<any>(null);

  // Extract listen option to avoid object reference issues
  const listen = options.listen;

  useEffect(() => {
    if (!query) {
      setLoading(false);
      return;
    }
    const sameQuery = prevQueryRef.current === query;
    if (!listen && sameQuery && (inFlightRef.current || data)) {
      return;
    }
    setLoading(true);
    prevQueryRef.current = query;

    if (listen) {
      const now = Date.now();
      if (lastErrorAtRef.current && (now - lastErrorAtRef.current) < errorCooldownMs) {
        setLoading(false);
        return;
      }
      if (process.env.NEXT_PUBLIC_DEBUG_FIRESTORE_HOOKS === 'true') console.log('useCollection: Subscribing with onSnapshot');
      const unsubscribe = onSnapshot(
        query,
        (snapshot: QuerySnapshot<T>) => {
          if (process.env.NEXT_PUBLIC_DEBUG_FIRESTORE_HOOKS === 'true') console.log('useCollection: onSnapshot received', snapshot.size, 'documents');
          const docs = snapshot.docs.map(
            (doc) => ({ ...doc.data(), id: doc.id } as T)
          );
          setData(docs);
          setLoading(false);
        },
        (err) => {
          const now = Date.now();
          const isPermission = (err as any)?.code === 'permission-denied';
          const isIndexMissing = (err as any)?.code === 'failed-precondition' || String((err as any)?.message || '').includes('requires an index');
          if (isPermission) {
            lastErrorAtRef.current = now;
            setLoading(false);
            // Do not log or emit user-facing errors on permission-denied; silently stop listening.
            setError(err as any);
            return;
          }
          if (isIndexMissing) {
            lastErrorAtRef.current = now;
            setError(err as any);
            setLoading(false);
            return;
          }
          if (process.env.NODE_ENV === 'development' && (now - lastLogAtRef.current > logCooldownMs)) {
            lastLogAtRef.current = now;
            console.error('useCollection: onSnapshot error', err);
          }
          const errorContext: FirestoreErrorContext = {
            operation: 'list',
            collection: 'collection-query',
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
      return () => { if (process.env.NEXT_PUBLIC_DEBUG_FIRESTORE_HOOKS === 'true') console.log('useCollection: Unsubscribe called'); unsubscribe(); };
    } else {
      if (process.env.NEXT_PUBLIC_DEBUG_FIRESTORE_HOOKS === 'true') console.log('useCollection: Fetching data with non-listening mode');
      const nowStart = Date.now();
      if (lastErrorAtRef.current && (nowStart - lastErrorAtRef.current) < errorCooldownMs) {
        setLoading(false);
        return;
      }
      inFlightRef.current = true;
      getDocs(query)
        .then((snapshot) => {
          if (process.env.NEXT_PUBLIC_DEBUG_FIRESTORE_HOOKS === 'true') console.log('useCollection: Data fetched successfully', snapshot.size, 'documents');
          const docs = snapshot.docs.map(
            (doc) => ({ ...doc.data(), id: doc.id } as T)
          );
          setData(docs);
          setLoading(false);
          inFlightRef.current = false;
          retryCountRef.current = 0;
          if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        })
        .catch((err) => {
          const now = Date.now();
          const isPermission = (err as any)?.code === 'permission-denied';
          const isIndexMissing = (err as any)?.code === 'failed-precondition' || String((err as any)?.message || '').includes('requires an index');
          if (isPermission) {
            // Silently return empty data for unauthorized reads to avoid console spam.
            setData([] as any);
            setLoading(false);
            setError(err as any);
            inFlightRef.current = false;
            return;
          }
          if (isIndexMissing) {
            lastErrorAtRef.current = now;
            setError(err as any);
            setLoading(false);
            inFlightRef.current = false;
            if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
            return;
          }
          if (process.env.NODE_ENV === 'development' && (now - lastLogAtRef.current > logCooldownMs)) {
            lastLogAtRef.current = now;
            console.error('useCollection: Error fetching data', err);
          }
          const errorContext: FirestoreErrorContext = {
            operation: 'list',
            collection: 'collection-query',
            additionalContext: { listen: false }
          };

          const handledError = handleFirestoreError(err, {
            context: errorContext,
            showUserFriendlyMessages: false
          });

          const canRetry = retryCountRef.current < 3;
          if (canRetry) {
            const delay = Math.min(2000, 500 * Math.pow(2, retryCountRef.current));
            retryCountRef.current += 1;
            if (!retryTimerRef.current) retryTimerRef.current = setTimeout(() => {
              if (prevQueryRef.current !== query) return;
              inFlightRef.current = true;
              getDocs(query)
                .then((snapshot2) => {
                  const docs2 = snapshot2.docs.map((doc) => ({ ...doc.data(), id: doc.id } as T));
                  setData(docs2);
                  setLoading(false);
                  inFlightRef.current = false;
                  retryCountRef.current = 0;
                  if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
                })
                .catch((err2) => {
                  const handled2 = handleFirestoreError(err2, { context: errorContext, showUserFriendlyMessages: false });
                  setError(handled2);
                  setLoading(false);
                  inFlightRef.current = false;
                });
            }, delay);
          } else {
            setError(handledError);
            setLoading(false);
            inFlightRef.current = false;
          }
        });
    }
  }, [query, listen]);

  return { data, loading, error };
}
