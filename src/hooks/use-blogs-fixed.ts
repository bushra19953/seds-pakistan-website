import { useState, useEffect } from 'react';
import { useFirestore } from '@/firebase';
import { collection, getDocs, orderBy, limit, query } from 'firebase/firestore';

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
        const q = query(
          blogsCol, 
          orderBy('createdAt', 'desc'),
          limit(limitCount)
        );
        
        const snapshot = await getDocs(q);
        const blogPosts: BlogPost[] = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
          createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
          updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
          publishedAt: doc.data().publishedAt?.toDate?.()?.toISOString?.() || undefined,
        })) as BlogPost[];
        
        // Filter for published blogs only
        const publishedBlogs = blogPosts.filter(blog => 
          blog.published === true && blog.status === 'published'
        );
        
        setBlogs(publishedBlogs);
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

        const blogsCol = collection(firestore, 'blogs');
        const q = query(
          blogsCol, 
          orderBy('createdAt', 'desc'),
          limit(limitCount)
        );
        
        const snapshot = await getDocs(q);
        const blogPosts: BlogPost[] = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
          createdAt: doc.data().createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
          updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString?.() || new Date().toISOString(),
          publishedAt: doc.data().publishedAt?.toDate?.()?.toISOString?.() || undefined,
        })) as BlogPost[];
        
        // Filter for published blogs only
        const publishedBlogs = blogPosts.filter(blog => 
          blog.published === true && blog.status === 'published'
        );
        
        setBlogs(publishedBlogs);
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