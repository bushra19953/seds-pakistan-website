/**
 * Enhanced blog hooks for the new production-ready blog system
 * Uses RESTful API endpoints instead of direct Firebase calls
 */

import { useState, useEffect, useCallback } from 'react';
import { EmorationalBlogPost } from '@/lib/blog-types';

interface BlogListResponse {
  blogs: EmorationalBlogPost[];
  pagination: {
    page: number;
    limit: number;
    hasNextPage: boolean;
    total: number;
  };
}

interface LatestBlogsResponse {
  blogs: EmorationalBlogPost[];
  count: number;
}

interface BlogPostResponse {
  blog: EmorationalBlogPost;
}

interface AuthorsResponse {
  authors: Array<{
    id: string;
    name: string;
    postCount: number;
    lastPostDate: Date | null;
  }>;
  totalCount: number;
  error?: string; // Optional error message for graceful degradation
}

interface CategoriesResponse {
  categories: Array<{
    id: string;
    name: string;
    postCount: number;
    slug: string;
  }>;
  totalCount: number;
}

interface UseBlogsOptions {
  page?: number;
  limit?: number;
  category?: string;
  author?: string;
  search?: string;
  autoFetch?: boolean;
}

interface UseBlogsReturn {
  blogs: EmorationalBlogPost[];
  loading: boolean;
  error: string | null;
  pagination: BlogListResponse['pagination'] | null;
  refetch: () => Promise<void>;
}

/**
 * Hook for fetching a paginated list of blog posts
 */
export function useBlogs(options: UseBlogsOptions = {}): UseBlogsReturn {
  const {
    page = 1,
    limit = 10,
    category,
    author,
    search,
    autoFetch = true
  } = options;

  const [blogs, setBlogs] = useState<EmorationalBlogPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<BlogListResponse['pagination'] | null>(null);

  const fetchBlogs = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
      });

      if (category && category !== 'all') {
        params.append('category', category);
      }

      if (author) {
        params.append('author', author);
      }

      if (search && search.trim()) {
        params.append('search', search.trim());
      }

      const response = await fetch(`/api/blogs?${params.toString()}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch blogs: ${response.statusText}`);
      }

      const data: BlogListResponse = await response.json();
      setBlogs(data.blogs);
      setPagination(data.pagination);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(errorMessage);
      setBlogs([]);
      setPagination(null);
    } finally {
      setLoading(false);
    }
  }, [page, limit, category, author, search]);

  useEffect(() => {
    if (autoFetch) {
      fetchBlogs();
    }
  }, [fetchBlogs, autoFetch]);

  return {
    blogs,
    loading,
    error,
    pagination,
    refetch: fetchBlogs,
  };
}

/**
 * Hook for fetching the latest blog posts (for homepage)
 */
export function useLatestBlogs(limit: number = 3) {
  const [blogs, setBlogs] = useState<EmorationalBlogPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLatestBlogs = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/blogs/latest?limit=${limit}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch latest blogs: ${response.statusText}`);
      }

      const data: LatestBlogsResponse = await response.json();
      setBlogs(data.blogs);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch latest blogs';
      setError(errorMessage);
      setBlogs([]);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchLatestBlogs();
  }, [fetchLatestBlogs]);

  return {
    blogs,
    loading,
    error,
    refetch: fetchLatestBlogs,
  };
}

/**
 * Hook for fetching a single blog post by slug
 */
export function useBlogPost(slug: string | null) {
  const [blog, setBlog] = useState<EmorationalBlogPost | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBlogPost = useCallback(async () => {
    if (!slug) return;

    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/blogs/${slug}`);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Blog post not found');
        }
        throw new Error(`Failed to fetch blog post: ${response.statusText}`);
      }

      const data: BlogPostResponse = await response.json();
      setBlog(data.blog);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch blog post';
      setError(errorMessage);
      setBlog(null);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    fetchBlogPost();
  }, [fetchBlogPost]);

  return {
    blog,
    loading,
    error,
    refetch: fetchBlogPost,
  };
}


/**
 * Hook for fetching authors
 * @param authorId - Optional author ID to fetch specific author
 * @param enabled - Set to false to skip fetching (for deferred loading)
 */
export function useAuthors(authorId?: string, enabled: boolean = true) {
  const [authors, setAuthors] = useState<AuthorsResponse['authors']>([]);
  const [loading, setLoading] = useState(enabled); // Only start loading if enabled
  const [error, setError] = useState<string | null>(null);

  const fetchAuthors = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const params = authorId ? `?id=${authorId}` : '';
      const response = await fetch(`/api/authors${params}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch authors: ${response.statusText}`);
      }

      const data: AuthorsResponse = await response.json();

      // Handle cases where authors may be returned as a string (e.g., '[]')
      // Ensure we pass a real array to the component
      let normalizedAuthors: AuthorsResponse['authors'] = [];
      if (Array.isArray((data as any).authors)) {
        normalizedAuthors = (data as any).authors;
      } else if (typeof (data as any).authors === 'string') {
        try {
          const parsed = JSON.parse((data as any).authors);
          if (Array.isArray(parsed)) {
            normalizedAuthors = parsed as AuthorsResponse['authors'];
          } else {
            console.warn('[useAuthors] Parsed authors string is not an array:', parsed);
          }
        } catch (parseErr) {
          console.warn('[useAuthors] Failed to parse authors string:', parseErr);
        }
      } else if ((data as any).authors == null) {
        // Explicitly treat null/undefined as empty array
        normalizedAuthors = [];
      } else {
        console.warn('[useAuthors] API returned non-array authors:', data);
      }

      setAuthors(normalizedAuthors);

      // If the API returned an error message, set it
      if (data.error) {
        setError(data.error);
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch authors';
      console.error('[useAuthors] Error fetching authors:', err);
      setError(errorMessage);
      setAuthors([]);
    } finally {
      setLoading(false);
    }
  }, [authorId, enabled]);

  useEffect(() => {
    if (enabled) {
      fetchAuthors();
    }
  }, [fetchAuthors, enabled]);

  return {
    authors,
    loading,
    error,
    refetch: fetchAuthors,
  };
}


/**
 * Hook for fetching categories
 */
export function useCategories(includeCounts: boolean = true) {
  const [categories, setCategories] = useState<CategoriesResponse['categories']>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCategories = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = includeCounts ? '?includeCounts=true' : '';
      const response = await fetch(`/api/categories${params}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch categories: ${response.statusText}`);
      }

      const data: CategoriesResponse = await response.json();
      setCategories(data.categories);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fetch categories';
      setError(errorMessage);
      setCategories([]);
    } finally {
      setLoading(false);
    }
  }, [includeCounts]);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  return {
    categories,
    loading,
    error,
    refetch: fetchCategories,
  };
}

/**
 * Hook for creating a new blog post (for admin interface)
 */
export function useCreateBlog() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createBlog = useCallback(async (blogData: Partial<EmorationalBlogPost>) => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/blogs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(blogData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create blog post');
      }

      const data = await response.json();
      return data;

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to create blog post';
      setError(errorMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    createBlog,
    loading,
    error,
  };
}

/**
 * Hook for updating a blog post (for admin interface)
 */
export function useUpdateBlog() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateBlog = useCallback(async (id: string, blogData: Partial<EmorationalBlogPost>) => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/admin/blogs/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(blogData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update blog post');
      }

      const data = await response.json();
      return data;

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to update blog post';
      setError(errorMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    updateBlog,
    loading,
    error,
  };
}

/**
 * Hook for deleting a blog post (for admin interface)
 */
export function useDeleteBlog() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deleteBlog = useCallback(async (id: string) => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/admin/blogs/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete blog post');
      }

      const data = await response.json();
      return data;

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete blog post';
      setError(errorMessage);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    deleteBlog,
    loading,
    error,
  };
}

interface UseBlogsInfiniteOptions {
  limit?: number;
  category?: string;
  author?: string;
  search?: string;
}

export function useBlogsInfinite(options: UseBlogsInfiniteOptions = {}) {
  const { limit = 12, category, author, search } = options;
  const [blogs, setBlogs] = useState<EmorationalBlogPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  const fetchBatch = useCallback(async (reset: boolean) => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({ limit: String(limit) });
      if (category && category !== 'all') params.append('category', category);
      if (author && author !== 'all') params.append('author', author);
      if (search && search.trim()) params.append('search', search.trim());
      if (!reset && nextCursor) params.append('cursor', nextCursor);

      const res = await fetch(`/api/blogs?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to fetch blogs: ${res.statusText}`);
      const data: { blogs: EmorationalBlogPost[]; pagination: { nextCursor: string | null; limit: number; count: number } } = await res.json();

      setBlogs((prev) => (reset ? data.blogs : [...prev, ...data.blogs]));
      setNextCursor(data.pagination.nextCursor);
      setHasMore(Boolean(data.pagination.nextCursor));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch blogs';
      setError(message);
      if (reset) setBlogs([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [limit, category, author, search]);

  useEffect(() => {
    setNextCursor(null);
    setHasMore(true);
    fetchBatch(true);
  }, [limit, category, author, search]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    await fetchBatch(false);
  }, [loading, hasMore, fetchBatch]);

  return { blogs, loading, error, hasMore, loadMore };
}
