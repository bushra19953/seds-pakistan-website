'use client'

import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, getDocs, DocumentData, where } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { useFirestore } from '@/firebase/provider';
import { useUser } from '@/firebase';

export interface Project {
  id: string;
  title: string;
  slug: string;
  summary: string;
  published: boolean;
  created_at: string;
  author_uid: string;
  image_url?: string;
  github_url?: string;
  live_url?: string;
}

export const useProjects = (numProjects: number = 3, featuredOnly: boolean = false) => {
  const db = useFirestore();
  const { user } = useUser();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        setLoading(true);
        const projectsCollection = collection(db, 'projects');

        let constraints: any[] = [limit(numProjects)];

        // Sorting
        // Note: we'll try to add orderBy, but handle case where index is missing

        // Featured filter
        if (featuredOnly) {
          constraints.push(where('showOnHomepage', '==', true));
        }

        // Guest filter (mandatory for rules)
        if (!user) {
          // We try 'status' in ['published', 'active', 'completed']
          constraints.push(where('status', 'in', ['published', 'active', 'completed']));
        }

        let q = query(projectsCollection, ...constraints);

        let querySnapshot;
        try {
          querySnapshot = await getDocs(q);
        } catch (e) {
          // If index error or other, fallback to no-order query
          const qNoOrder = query(projectsCollection, ...constraints);
          querySnapshot = await getDocs(qNoOrder);
        }

        const fetchedProjects: Project[] = querySnapshot.docs.map(doc => {
          const data = doc.data() as DocumentData;
          const createdVal = data.created_at || data.createdAt;
          const created = createdVal?.toDate ? createdVal.toDate() : new Date(createdVal ?? Date.now());
          return {
            id: doc.id,
            title: data.title,
            slug: data.slug,
            summary: data.summary,
            published: data.published ?? data.status === 'published',
            created_at: created.toISOString(),
            author_uid: data.author_uid || data.createdBy,
            image_url: data.imageUrl || data.image_url || (Array.isArray(data.media) ? data.media[0] : undefined),
            github_url: data.github_url || data.github_repo || undefined,
            live_url: data.live_url || data.docs_url || undefined,
          };
        });

        // Always sort client-side for consistency
        const sorted = fetchedProjects.sort((a, b) => (new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
        setProjects(sorted);
      } catch (err) {
        console.error('Error fetching projects:', err);
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    };

    fetchProjects();
  }, [numProjects, featuredOnly, user, db]);

  return { projects, loading, error };
};
