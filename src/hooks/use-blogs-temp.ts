import { useState, useEffect } from 'react';

// Temporary fallback with mock data to avoid permission errors
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

// Mock data for temporary use while Firestore rules are being deployed
const MOCK_BLOGS: BlogPost[] = [
  {
    id: 'blog-1',
    title: 'Welcome to SEDS Pakistan',
    body: 'We are excited to announce the launch of SEDS Pakistan...',
    authorUid: 'admin',
    authorName: 'SEDS Pakistan Team',
    published: true,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
    publishedAt: '2024-01-15T10:00:00Z',
    tags: ['announcement', 'seds'],
    summary: 'Introducing SEDS Pakistan - advancing space science education in Pakistan.',
    slug: 'welcome-to-seds-pakistan',
    status: 'published'
  },
  {
    id: 'blog-2',
    title: 'Space Technology in Pakistan',
    body: 'Pakistan has been making significant strides in space technology...',
    authorUid: 'admin',
    authorName: 'SEDS Pakistan Team',
    published: true,
    createdAt: '2024-01-10T14:30:00Z',
    updatedAt: '2024-01-10T14:30:00Z',
    publishedAt: '2024-01-10T14:30:00Z',
    tags: ['technology', 'space', 'pakistan'],
    summary: 'Exploring Pakistan\'s growing space technology sector and opportunities.',
    slug: 'space-technology-pakistan',
    status: 'published'
  },
  {
    id: 'blog-3',
    title: 'Student Rocket Competition 2024',
    body: 'We are organizing an exciting rocket building competition for students...',
    authorUid: 'admin',
    authorName: 'SEDS Pakistan Team',
    published: true,
    createdAt: '2024-01-05T09:15:00Z',
    updatedAt: '2024-01-05T09:15:00Z',
    publishedAt: '2024-01-05T09:15:00Z',
    tags: ['competition', 'rocketry', 'students'],
    summary: 'Join our annual student rocket competition and showcase your engineering skills.',
    slug: 'student-rocket-competition-2024',
    status: 'published'
  }
];

export const useBlogs = (limitCount: number = 10) => {
  const [blogs, setBlogs] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchBlogs = async () => {
      try {
        setLoading(true);
        
        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const limitedBlogs = MOCK_BLOGS.slice(0, limitCount);
        setBlogs(limitedBlogs);
        setError(null);
      } catch (err) {
        setError('Failed to fetch blogs.');
        setBlogs([]);
      } finally {
        setLoading(false);
      }
    };

    fetchBlogs();
  }, [limitCount]);

  return { blogs, loading, error };
}

// Special hook for latest blogs (used in homepage Latest Updates section)
export const useLatestBlogs = (limitCount: number = 3) => {
  const [blogs, setBlogs] = useState<BlogPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchLatestBlogs = async () => {
      try {
        setLoading(true);
        
        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const limitedBlogs = MOCK_BLOGS.slice(0, limitCount);
        setBlogs(limitedBlogs);
        setError(null);
      } catch (err) {
        setError('Failed to fetch latest blogs.');
        setBlogs([]);
      } finally {
        setLoading(false);
      }
    };

    fetchLatestBlogs();
  }, [limitCount]);

  return { blogs, loading, error };
}