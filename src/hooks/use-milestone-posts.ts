/**
 * Hook for fetching milestone blog posts for the Interactive Milestone Timeline
 * This leverages the existing blog system by filtering for the 'milestone' category
 */

import { useState, useEffect, useCallback } from 'react';

interface MilestoneBlogPost {
  id: string;
  title: string;
  summary?: string;
  slug?: string;
  body: string;
  authorUid: string;
  authorName?: string;
  thumbnailUrl?: string;
  categoryId: string;
  status: 'draft' | 'pending_review' | 'published';
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
  tags?: string[];
}

interface UseMilestonePostsReturn {
  milestones: MilestoneBlogPost[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Hook for fetching milestone blog posts (latest 7 for homepage timeline)
 */
export function useMilestonePosts(limit: number = 7): UseMilestonePostsReturn {
  const [milestones, setMilestones] = useState<MilestoneBlogPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMilestonePosts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch blogs filtered by 'milestone' category
      const params = new URLSearchParams({
        limit: limit.toString(),
        category: 'milestone' // Filter specifically for milestone posts
      });

      const response = await fetch(`/api/blogs?${params.toString()}`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch milestone posts: ${response.statusText}`);
      }

      const data = await response.json();
      
      // Filter for published milestone posts only and sort by date (newest first)
      const publishedMilestones = (data.blogs || [])
        .filter((blog: MilestoneBlogPost) => 
          blog.categoryId === 'milestone' && 
          blog.status === 'published' &&
          blog.publishedAt
        )
        .sort((a: MilestoneBlogPost, b: MilestoneBlogPost) => {
          const dateA = new Date(a.publishedAt || a.createdAt).getTime();
          const dateB = new Date(b.publishedAt || b.createdAt).getTime();
          return dateB - dateA; // Newest first
        })
        .slice(0, limit); // Ensure we don't exceed the limit

      setMilestones(publishedMilestones);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch milestone posts';
      
      // CRITICAL: Loud error logging for debugging
      console.error('CRITICAL: MILESTONE TIMELINE FAILED TO FETCH DATA', {
        error: err,
        message: errorMessage,
        timestamp: new Date().toISOString(),
        context: {
          endpoint: '/api/blogs',
          params: { category: 'milestone', limit: limit },
          stack: err instanceof Error ? err.stack : undefined
        }
      });
      
      setError(errorMessage);
      setMilestones([]);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchMilestonePosts();
  }, [fetchMilestonePosts]);

  return {
    milestones,
    loading,
    error,
    refetch: fetchMilestonePosts,
  };
}