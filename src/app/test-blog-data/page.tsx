'use client';

import { useEffect, useState } from 'react';
import { useFirestore } from '@/firebase';
import { collection, query, getDocs } from 'firebase/firestore';

export default function TestBlogData() {
  const firestore = useFirestore();
  const [blogs, setBlogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchBlogs = async () => {
      try {
        setLoading(true);
        const blogsRef = collection(firestore, 'blogs');
        const blogsQuery = query(blogsRef);
        const querySnapshot = await getDocs(blogsQuery);
        
        const blogsData: any[] = [];
        querySnapshot.forEach((doc) => {
          blogsData.push({ id: doc.id, ...doc.data() });
        });
        
        setBlogs(blogsData);
        setError(null);
      } catch (err) {
        console.error('Error fetching blogs:', err);
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchBlogs();
  }, [firestore]);

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error: {error}</div>;
  }

  return (
    <div>
      <h1>Blog Data Test</h1>
      <p>Total blogs: {blogs.length}</p>
      {blogs.map((blog) => (
        <div key={blog.id} style={{ border: '1px solid #ccc', margin: '10px', padding: '10px' }}>
          <h2>{blog.title}</h2>
          <p>Status: {blog.status}</p>
          <p>Published: {blog.published?.toString()}</p>
          <p>Created At: {blog.createdAt?.toString()}</p>
        </div>
      ))}
    </div>
  );
}