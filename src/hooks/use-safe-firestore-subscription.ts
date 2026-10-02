import { useState, useEffect, useRef } from 'react';
import { 
  onSnapshot, 
  Query, 
  QueryDocumentSnapshot, 
  DocumentData,
  Unsubscribe
} from 'firebase/firestore';

/**
 * 🛡️ STANDARDIZED FIRESTORE SUBSCRIPTION HOOK
 * 
 * Purpose: Eliminates memory leaks by enforcing consistent cleanup patterns
 * across all components that use real-time Firestore listeners.
 * 
 * Key Benefits:
 * - Prevents memory leaks through proper cleanup
 * - Standardizes error handling across components
 * - Provides consistent loading and data states
 * - Automatically handles component unmounting cleanup
 * 
 * Usage: Replace all direct onSnapshot calls with this hook
 */

interface UseSafeFirestoreSubscriptionOptions<T> {
  initialData?: T[];
  transform?: (docs: QueryDocumentSnapshot<DocumentData>[]) => T[];
  onError?: (error: Error) => void;
  enabled?: boolean;
}

interface UseSafeFirestoreSubscriptionReturn<T> {
  data: T[] | null;
  loading: boolean;
  error: Error | null;
  unsubscribe: Unsubscribe | null;
  refetch: () => void;
}

/**
 * Safe Firestore subscription hook with memory leak prevention
 */
export function useSafeFirestoreSubscription<T = any>(
  query: Query<DocumentData> | null,
  options: UseSafeFirestoreSubscriptionOptions<T> = {}
): UseSafeFirestoreSubscriptionReturn<T> {
  const {
    initialData = [],
    transform,
    onError,
    enabled = true
  } = options;

  const [data, setData] = useState<T[] | null>(initialData.length > 0 ? initialData : null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [unsubscribe, setUnsubscribe] = useState<Unsubscribe | null>(null);
  
  const isMountedRef = useRef(true);
  const queryRef = useRef(query);

  // Update query ref when it changes
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [unsubscribe]);

  // Subscribe to Firestore query
  useEffect(() => {
    if (!enabled || !query || !isMountedRef.current) {
      setLoading(false);
      return;
    }

    // Cleanup any existing subscription
    if (unsubscribe) {
      unsubscribe();
    }

    setLoading(true);
    setError(null);

    console.log(`🔄 [SAFE-SUB] Starting subscription to query:`, query.toString());

    let localUnsubscribe: Unsubscribe | null = null;
    try {
      const newUnsubscribe = onSnapshot(
        query,
        (snapshot) => {
          // Ensure component is still mounted before updating state
          if (!isMountedRef.current) {
            return;
          }

          try {
            let result: T[];
            
            if (transform) {
              // Use custom transform function
              result = transform(snapshot.docs);
            } else {
              // Default transformation - convert docs to objects with IDs
              result = snapshot.docs.map((doc) => ({
                id: doc.id,
                ...doc.data()
              })) as T[];
            }

            setData(result);
            setLoading(false);
            setError(null);

            console.log(`✅ [SAFE-SUB] Subscription successful:`, {
              docCount: snapshot.docs.length,
              query: query.toString()
            });

          } catch (transformError) {
            const err = transformError instanceof Error ? transformError : new Error('Transform failed');
            console.error(`❌ [SAFE-SUB] Transform error:`, err);
            setError(err);
            setLoading(false);
            
            if (onError) {
              onError(err);
            }
          }
        },
        (snapError) => {
          // Ensure component is still mounted before updating state
          if (!isMountedRef.current) {
            return;
          }

          console.error(`❌ [SAFE-SUB] Subscription error:`, snapError);
          const error = snapError instanceof Error ? snapError : new Error('Firestore subscription failed');
          setError(error);
          setLoading(false);
          
          if (onError) {
            onError(error);
          }
        }
      );

      localUnsubscribe = newUnsubscribe;
      setUnsubscribe(() => newUnsubscribe);

    } catch (setupError) {
      const err = setupError instanceof Error ? setupError : new Error('Failed to setup subscription');
      console.error(`❌ [SAFE-SUB] Setup error:`, err);
      setError(err);
      setLoading(false);
      
      if (onError) {
        onError(err);
      }
    }

    // Cleanup function
    return () => {
      if (localUnsubscribe) {
        console.log(`🧹 [SAFE-SUB] Cleaning up subscription`);
        localUnsubscribe();
      }
    };
  }, [query, enabled, transform, onError]);

  // Manual refetch function
  const refetch = () => {
    if (unsubscribe && query) {
      unsubscribe();
      // The effect will automatically resubscribe due to dependency array
    }
  };

  return {
    data,
    loading,
    error,
    unsubscribe,
    refetch
  };
}

/**
 * Specialized hook for single document subscriptions
 */
export function useSafeFirestoreDoc<T = any>(
  docRef: any,
  options: Omit<UseSafeFirestoreSubscriptionOptions<T>, 'transform'> = {}
) {
  const transform = (docs: QueryDocumentSnapshot<DocumentData>[]) => {
    if (docs.length === 0) return [] as (T | null)[];
    const item = { id: docs[0].id, ...docs[0].data() } as T;
    return [item] as (T | null)[];
  };

  const result = useSafeFirestoreSubscription<T | null>(docRef, {
    ...options,
    transform,
    initialData: []
  });

  return {
    data: result.data,
    loading: result.loading,
    error: result.error,
    unsubscribe: result.unsubscribe,
    refetch: result.refetch
  };
}

/**
 * Hook for managing multiple document subscriptions with cleanup
 */
export function useSafeFirestoreDocuments<T = any>(
  queries: Array<{ query: Query<DocumentData>; key: string }>,
  options: Omit<UseSafeFirestoreSubscriptionOptions<T>, 'transform'> = {}
) {
  const { initialData = [], onError, enabled = true } = options;
  const [allData, setAllData] = useState<Record<string, T[]>>({});
  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, Error | null>>({});
  const [refetchTick, setRefetchTick] = useState(0);

  // Single effect owns all subscriptions imperatively — the query list is
  // dynamic, so per-query hooks would violate the rules of hooks.
  useEffect(() => {
    if (!enabled || queries.length === 0) {
      setLoadingStates({});
      return;
    }

    let cancelled = false;
    const unsubscribes: Unsubscribe[] = [];

    setLoadingStates(Object.fromEntries(queries.map(({ key }) => [key, true])));
    setErrors(Object.fromEntries(queries.map(({ key }) => [key, null])));
    if (initialData.length > 0) {
      setAllData(Object.fromEntries(queries.map(({ key }) => [key, initialData])));
    }

    for (const { query, key } of queries) {
      try {
        const unsub = onSnapshot(
          query,
          (snapshot) => {
            if (cancelled) return;
            try {
              const result = snapshot.docs.map((doc) => ({
                id: doc.id,
                ...doc.data()
              })) as T[];
              setAllData((prev) => ({ ...prev, [key]: result }));
              setLoadingStates((prev) => ({ ...prev, [key]: false }));
              setErrors((prev) => ({ ...prev, [key]: null }));
            } catch (transformError) {
              const err = transformError instanceof Error ? transformError : new Error('Transform failed');
              setErrors((prev) => ({ ...prev, [key]: err }));
              setLoadingStates((prev) => ({ ...prev, [key]: false }));
              if (onError) onError(err);
            }
          },
          (snapError) => {
            if (cancelled) return;
            const err = snapError instanceof Error ? snapError : new Error('Firestore subscription failed');
            setErrors((prev) => ({ ...prev, [key]: err }));
            setLoadingStates((prev) => ({ ...prev, [key]: false }));
            if (onError) onError(err);
          }
        );
        unsubscribes.push(unsub);
      } catch (setupError) {
        const err = setupError instanceof Error ? setupError : new Error('Failed to setup subscription');
        setErrors((prev) => ({ ...prev, [key]: err }));
        setLoadingStates((prev) => ({ ...prev, [key]: false }));
        if (onError) onError(err);
      }
    }

    return () => {
      cancelled = true;
      unsubscribes.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refetchTick, ...queries.map(({ key }) => key)]);

  const hasErrors = Object.values(errors).some((error) => error !== null);
  const isLoading = Object.values(loadingStates).some((loading) => loading);

  return {
    data: allData,
    loading: isLoading,
    error: hasErrors ? errors : null,
    refetch: () => setRefetchTick((t) => t + 1)
  };
}

/**
 * Custom hook for real-time user authentication state with cleanup
 */
export function useSafeUserSubscription(user: any, firestore: any) {
  const userDocRef = user ? firestore.collection('users').doc(user.uid) : null;
  
  return useSafeFirestoreDoc(userDocRef, {
    enabled: !!user,
    onError: (error) => {
      console.error('User subscription error:', error);
    }
  });
}

/**
 * Utility hook for creating controlled subscriptions with enable/disable
 */
export function useControlledSubscription<T = any>(
  query: Query<DocumentData> | null,
  enabled: boolean,
  options: UseSafeFirestoreSubscriptionOptions<T> = {}
) {
  return useSafeFirestoreSubscription<T>(query, {
    ...options,
    enabled
  });
}
