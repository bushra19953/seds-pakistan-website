/**
 * Enhanced project hooks for recruitment and sponsorship showcases
 * These leverage the existing project system but add filtering for featured projects
 */

import { useState, useEffect, useCallback } from 'react';
import { collection, query as firestoreQuery, where, limit as firestoreLimit, getDocs, DocumentData } from 'firebase/firestore';
import { useFirestore } from '@/firebase';
import type { EnhancedProject } from '@/types/enhanced-project';

interface UseFeaturedProjectsOptions {
  limit?: number;
  featuredOnRecruitment?: boolean;
  featuredOnSponsorship?: boolean;
  category?: string;
}

interface UseFeaturedProjectsReturn {
  projects: EnhancedProject[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook for fetching featured projects for recruitment and sponsorship showcases
 */
export function useFeaturedProjects(options: UseFeaturedProjectsOptions = {}): UseFeaturedProjectsReturn {
  const {
    limit = 6,
    featuredOnRecruitment = false,
    featuredOnSponsorship = false,
    category
  } = options;

  const firestore = useFirestore();
  const [projects, setProjects] = useState<EnhancedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFeaturedProjects = useCallback(async () => {
    if (!firestore) return;

    try {
      setLoading(true);
      setError(null);

      let q = collection(firestore, 'projects');

      // Build the query step by step
      let projectQuery = firestoreQuery(q, where('published', '==', true));

      // Apply feature filters
      if (featuredOnRecruitment) {
        projectQuery = firestoreQuery(projectQuery, where('featured_on_recruitment_page', '==', true));
      }

      if (featuredOnSponsorship) {
        projectQuery = firestoreQuery(projectQuery, where('featured_on_sponsorship_page', '==', true));
      }

      if (category) {
        projectQuery = firestoreQuery(projectQuery, where('category', '==', category));
      }

      // Apply limit
      projectQuery = firestoreQuery(projectQuery, firestoreLimit(limit));
      
      let querySnapshot;
      try {
        querySnapshot = await getDocs(projectQuery);
      } catch (err) {
        // If composite index error, try without complex filters
        console.warn('Complex query failed, falling back to simpler query:', err);
        q = collection(firestore, 'projects');
        projectQuery = firestoreQuery(q, where('published', '==', true), firestoreLimit(limit));
        querySnapshot = await getDocs(projectQuery);
      }

      const fetchedProjects: EnhancedProject[] = querySnapshot.docs.map((doc) => {
        const data = doc.data() as DocumentData;
        return {
          id: doc.id,
          title: data.title,
          slug: data.slug || doc.id,
          summary: data.summary || '',
          description: data.description || '',
          published: data.published ?? false,
          status: data.project_status || data.status,
          created_at: data.created_at?.toDate?.()?.toISOString() || new Date().toISOString(),
          updated_at: data.updated_at?.toDate?.()?.toISOString(),
          author_uid: data.author_uid,
          image_url: data.image_url,
          featured_image_url: data.featured_image_url,
          github_url: data.github_url,
          live_url: data.live_url,
          category: data.category,
          tags: data.tags || [],
          tech_stack: data.tech_stack || [],
          sponsors: data.sponsors || [],
          media_gallery: data.media_gallery || [],
          downloads: data.downloads || [],
          featured_on_recruitment_page: data.featured_on_recruitment_page || false,
          featured_on_sponsorship_page: data.featured_on_sponsorship_page || false,
          view_count: data.view_count || 0,
          started_at: data.started_at?.toDate?.(),
          completed_at: data.completed_at?.toDate?.(),
        } as EnhancedProject;
      });

      setProjects(fetchedProjects);

    } catch (err) {
      console.error('Error fetching featured projects:', err);
      setError('Failed to load projects');
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, [firestore, limit, featuredOnRecruitment, featuredOnSponsorship, category]);

  useEffect(() => {
    fetchFeaturedProjects();
  }, [fetchFeaturedProjects]);

  return {
    projects,
    loading,
    error,
    refetch: fetchFeaturedProjects,
  };
}

/**
 * Hook for fetching projects by category (for filtered sponsorship gallery)
 */
export function useProjectsByCategory(category: string, limit: number = 12) {
  return useFeaturedProjects({
    limit,
    category,
    featuredOnSponsorship: true
  });
}

/**
 * Hook for fetching projects for recruitment showcase
 */
export function useRecruitmentProjects(limit: number = 4) {
  return useFeaturedProjects({
    limit,
    featuredOnRecruitment: true
  });
}