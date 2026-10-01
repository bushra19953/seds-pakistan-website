'use client'

import { useEffect, useState } from 'react';
import { collection, query, where, orderBy, limit, getDocs, DocumentData } from 'firebase/firestore';
import { useFirestore } from '@/firebase/provider';

export interface Workshop {
  id: string;
  title: string;
  slug: string;
  summary: string;
  published: boolean;
  created_at: string;
  author_uid: string;
  image_url?: string;
  registration_url?: string;
  event_date?: string;
}

/**
 * Hook to fetch workshops from the consolidated events collection.
 * Workshops are events with type='workshop'.
 */
export const useWorkshops = (numWorkshops: number = 3) => {
  const db = useFirestore();
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fetchWorkshops = async () => {
      try {
        setLoading(true);
        // Query from consolidated events collection where type='workshop'
        const eventsCollection = collection(db, 'events');
        const q = query(
          eventsCollection,
          where('type', '==', 'workshop'),
          where('status', '==', 'published'),
          limit(numWorkshops)
        );
        const querySnapshot = await getDocs(q);
        const fetchedWorkshops: Workshop[] = querySnapshot.docs.map(doc => {
          const data = doc.data() as DocumentData;
          // Map event fields to Workshop interface for backwards compatibility
          const createdAt = data.createdAt || data.created_at;
          const eventDate = data.startAt || data.event_date;
          return {
            id: doc.id,
            title: data.title,
            slug: data.slug,
            summary: data.summary || data.description || '',
            published: data.status === 'published',
            created_at: createdAt?.toDate?.().toISOString() || new Date().toISOString(),
            author_uid: data.createdByUid || data.author_uid || '',
            image_url: data.imageUrl || data.image_url || undefined,
            registration_url: data.registration_url || data.registrationUrl || undefined,
            event_date: eventDate?.toDate?.().toISOString() || undefined,
          };
        });
        setWorkshops(fetchedWorkshops);
      } catch (err) {
        console.error('Error fetching workshops from events:', err);
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    };

    fetchWorkshops();
  }, [db, numWorkshops]);

  return { workshops, loading, error };
};