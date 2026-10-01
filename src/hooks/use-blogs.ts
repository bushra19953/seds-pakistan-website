import { useState, useEffect } from 'react';
import { useFirestore } from '@/firebase';
import { collection, getDocs, where, limit, query } from 'firebase/firestore';

// Types matching our API response
interface BlogPost {
  id: string;
  title: string;
  body: string;
  authorUid: string;
  authorName: string;
  published: boolean;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  tags: string[];
  thumbnailUrl?: string;
  summary?: string;
  slug?: string;
  metaTitle?: string;
  metaDescription?: string;
  keywords?: string;
  newsArticleUrl?: string;
  status: 'draft' | 'pending_review' | 'published';
  categoryId?: string;
}

export const useBlogs = (limitCount: number = 10) => {
  const firestore = useFirestore();
  const [blogs, setBlogs] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchBlogs = async () => {
      try {
        setLoading(true);
        
        if (!firestore) {
          throw new Error('Firestore service unavailable');
        }

        const blogsCol = collection(firestore, 'blogs');
        // Restrict to published to satisfy public read rules; sort client-side
        const q = query(blogsCol, where('status','==','published'), limit(limitCount));
        const snapshot = await getDocs(q);
        const blogPosts: BlogPost[] = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
          createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
          updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
          publishedAt: doc.data().publishedAt?.toDate?.()?.toISOString?.() || undefined,
        })) as BlogPost[];
        // Sort latest first by publishedAt
        const sorted = blogPosts.sort((a,b) => new Date(b.publishedAt || b.createdAt).getTime() - new Date(a.publishedAt || a.createdAt).getTime());
        setBlogs(sorted);
        setError(null);
      } catch (err) {
        console.error('Error fetching blogs:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch blogs.');
        setBlogs([]);
      } finally {
        setLoading(false);
      }
    };

    fetchBlogs();
  }, [limitCount, firestore]);

  return { blogs, loading, error };
}

// Special hook for latest blogs (used in homepage Latest Updates section)
export const useLatestBlogs = (limitCount: number = 3) => {
  const firestore = useFirestore();
  const [blogs, setBlogs] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchLatestBlogs = async () => {
      try {
        setLoading(true);
        
        if (!firestore) {
          throw new Error('Firestore service unavailable');
        }

        // Prefer server API to avoid client rule issues and heavy composite indexes
        const resp = await fetch(`/api/blogs/latest?limit=${encodeURIComponent(String(limitCount))}`);
        if (!resp.ok) {
          throw new Error(`Latest blogs API failed: ${resp.status}`);
        }
        const json = await resp.json();
        const items = Array.isArray(json.blogs) ? json.blogs : [];
        const blogPosts: BlogPost[] = items.map((d: any) => ({
          id: String(d.id || ''),
          title: String(d.title || ''),
          body: String(d.body || ''),
          authorUid: String(d.authorUid || d.authorId || ''),
          authorName: String(d.authorName || ''),
          published: d.status === 'published' || d.published === true,
          createdAt: (d.createdAt instanceof Date ? d.createdAt.toISOString() : (d.createdAt ? String(d.createdAt) : new Date().toISOString())),
          updatedAt: (d.updatedAt instanceof Date ? d.updatedAt.toISOString() : (d.updatedAt ? String(d.updatedAt) : new Date().toISOString())),
          publishedAt: d.publishedAt instanceof Date ? d.publishedAt.toISOString() : (d.publishedAt ? String(d.publishedAt) : undefined),
          tags: Array.isArray(d.tags) ? d.tags : [],
          thumbnailUrl: d.thumbnailUrl || undefined,
          summary: d.summary || undefined,
          slug: d.slug || undefined,
          metaTitle: d.metaTitle || undefined,
          metaDescription: d.metaDescription || undefined,
          keywords: d.keywords || undefined,
          newsArticleUrl: d.newsArticleUrl || undefined,
          status: String(d.status || 'published') as any,
          categoryId: d.categoryId || undefined,
        }));
        setBlogs(blogPosts);
        setError(null);
      } catch (err) {
        console.error('Error fetching latest blogs:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch latest blogs.');
        setBlogs([]);
      } finally {
        setLoading(false);
      }
    };

    fetchLatestBlogs();
  }, [limitCount, firestore]);

  return { blogs, loading, error };
}