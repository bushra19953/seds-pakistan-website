'use client';

import { useEffect, useState } from 'react';
import { useFirestore } from '@/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';

export default function DebugBlogsPage() {
  const firestore = useFirestore();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        
        // Get all blogs
        const allSnapshot = await getDocs(collection(firestore, 'blogs'));
        
        const allBlogs: any[] = [];
        allSnapshot.forEach(doc => {
          allBlogs.push({
            id: doc.id,
            ...doc.data()
          });
        });
        
        // Get published blogs
        const publishedQuery = query(
          collection(firestore, 'blogs'),
          where('status', '==', 'published')
        );
        const publishedSnapshot = await getDocs(publishedQuery);
        
        const publishedBlogs: any[] = [];
        publishedSnapshot.forEach(doc => {
          publishedBlogs.push({
            id: doc.id,
            ...doc.data()
          });
        });
        
        // Get old published blogs
        const oldPublishedQuery = query(
          collection(firestore, 'blogs'),
          where('published', '==', true)
        );
        const oldPublishedSnapshot = await getDocs(oldPublishedQuery);
        
        const oldPublishedBlogs: any[] = [];
        oldPublishedSnapshot.forEach(doc => {
          oldPublishedBlogs.push({
            id: doc.id,
            ...doc.data()
          });
        });
        
        setData({
          total: allBlogs.length,
          published: publishedBlogs.length,
          oldPublished: oldPublishedBlogs.length,
          allBlogs,
          publishedBlogs,
          oldPublishedBlogs
        });
      } catch (err: any) {
        console.error('Error fetching data:', err);
        setError(err.message || 'An unknown error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [firestore]);

  if (loading) return <div className="p-8">Loading...</div>;
  if (error) return <div className="p-8 text-red-500">Error: {error}</div>;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Blog Debug Information</h1>
      
      {data && (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Summary</h2>
            <p>Total blogs: {data.total}</p>
            <p>Published blogs (status == 'published'): {data.published}</p>
            <p>Old published blogs (published == true): {data.oldPublished}</p>
          </div>
          
          <div>
            <h2 className="text-xl font-semibold">All Blogs ({data.allBlogs.length})</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.allBlogs.map((blog: any) => (
                <div key={blog.id} className="border p-4 rounded">
                  <h3 className="font-bold">{blog.title || 'No title'}</h3>
                  <p>ID: {blog.id}</p>
                  <p>Status: {blog.status || 'No status'}</p>
                  <p>Published: {blog.published?.toString() || 'Not set'}</p>
                  <p>Author: {blog.authorName || blog.authorUid || 'Unknown'}</p>
                </div>
              ))}
            </div>
          </div>
          
          <div>
            <h2 className="text-xl font-semibold">Published Blogs ({data.publishedBlogs.length})</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.publishedBlogs.length > 0 ? (
                data.publishedBlogs.map((blog: any) => (
                  <div key={blog.id} className="border p-4 rounded">
                    <h3 className="font-bold">{blog.title || 'No title'}</h3>
                    <p>ID: {blog.id}</p>
                    <p>Author: {blog.authorName || blog.authorUid || 'Unknown'}</p>
                  </div>
                ))
              ) : (
                <p>No blogs with status 'published' found</p>
              )}
            </div>
          </div>
          
          <div>
            <h2 className="text-xl font-semibold">Old Published Blogs ({data.oldPublishedBlogs.length})</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.oldPublishedBlogs.length > 0 ? (
                data.oldPublishedBlogs.map((blog: any) => (
                  <div key={blog.id} className="border p-4 rounded">
                    <h3 className="font-bold">{blog.title || 'No title'}</h3>
                    <p>ID: {blog.id}</p>
                    <p>Author: {blog.authorName || blog.authorUid || 'Unknown'}</p>
                  </div>
                ))
              ) : (
                <p>No blogs with published == true found</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}