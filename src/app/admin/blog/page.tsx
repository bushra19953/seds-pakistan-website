"use client";

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useUser, useFirestore, useCollection } from '@/firebase';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { useAuthorization } from '@/hooks/use-authorization';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { Input } from '@/components/ui/input';
import { Plus, Search, Edit, Trash, ExternalLink, Filter, RefreshCw } from 'lucide-react';
import { collection, query, orderBy, where } from 'firebase/firestore';
import Link from 'next/link';
import { format } from 'date-fns';
import { deleteDoc, doc } from 'firebase/firestore';
import { useToast } from '@/hooks/use-toast';
import Footer from '@/components/layout/footer';

export default function BlogAdminPage() {
  const { user, role, isLoading: userLoading } = useUser();
  const { isAuthorized: canManageBlogs, isLoading: authLoading } = useAuthorization('canManageBlogs');
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const blogsQuery = useMemo(() => {
    if (!firestore) return null;
    return query(collection(firestore, 'blogs'), orderBy('createdAt', 'desc'));
  }, [firestore]);

  const { data: blogs, loading: blogsLoading, error } = useCollection(blogsQuery, { listen: true });

  const filteredBlogs = useMemo(() => {
    if (!blogs) return [];
    return blogs.filter(blog => {
      const matchesSearch = blog.title?.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          blog.authorName?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === 'all' || blog.status === statusFilter;
      const isNotDeleted = !blog.deleted;
      return matchesSearch && matchesStatus && isNotDeleted;
    });
  }, [blogs, searchTerm, statusFilter]);

  const handleDeleteBlogPost = async (id: string) => {
    if (!confirm('Are you sure you want to delete this blog post? This action is irreversible.')) return;

    try {
      // Use the API for deletion to ensure backend enforcement
      const token = await user?.getIdToken();
      const res = await fetch(`/api/admin/blogs/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (res.ok) {
        toast({ title: "Success", description: "Blog post deleted successfully." });
      } else {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete blog post.");
      }
    } catch (e: any) {
      console.error("Delete error:", e);
      toast({ variant: "destructive", title: "Error", description: e.message });
    }
  };

  if (userLoading || authLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="font-mono text-xs uppercase animate-pulse">Synchronizing Auth Systems...</p>
      </div>
    );
  }

  return (
    <AuthorizationGate permission="canManageBlogs">
      <div className="space-y-8 pb-10">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-4xl font-black text-white uppercase tracking-tighter flex items-center gap-3">
               Blog Command Center
            </h1>
            <p className="text-slate-500 font-mono text-xs uppercase tracking-widest mt-1">Global editorial control and content management</p>
          </div>
          <Button asChild className="bg-primary text-black font-black uppercase tracking-widest">
            <Link href="/admin/blogs/new">
              <Plus className="h-4 w-4 mr-2" /> CREATE POST
            </Link>
          </Button>
        </div>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-xl">
          <CardContent className="p-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                <Input
                  placeholder="Filter transmissions by title or author..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="bg-slate-950 border-slate-800 text-sm h-11 pl-10"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="border-slate-800 h-11 px-4"
                  onClick={() => {
                    const options = ['all', 'published', 'draft', 'archived'];
                    const idx = options.indexOf(statusFilter);
                    setStatusFilter(options[(idx + 1) % options.length]);
                  }}
                  title="Click to cycle through status filters"
                >
                   <Filter className="h-4 w-4 mr-2" /> STATUS: {statusFilter.toUpperCase()}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-xl">
          <CardHeader className="border-b border-slate-800/50">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-xl font-bold uppercase tracking-tight text-white">Transmission Registry</CardTitle>
                <CardDescription className="text-[10px] uppercase font-mono text-slate-500">{filteredBlogs.length} Active Records Filtered</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {blogsLoading ? (
              <div className="p-8 text-center animate-pulse font-mono text-xs">SCANNING DATABASE...</div>
            ) : filteredBlogs.length === 0 ? (
              <div className="p-20 text-center">
                <p className="text-slate-500 font-mono text-xs italic tracking-widest">No blog posts found matching your criteria.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-slate-950/50">
                    <TableRow className="hover:bg-transparent border-slate-800">
                      <TableHead className="text-[10px] font-black uppercase tracking-widest text-slate-400">Article Identity</TableHead>
                      <TableHead className="text-[10px] font-black uppercase tracking-widest text-slate-400">Author</TableHead>
                      <TableHead className="text-[10px] font-black uppercase tracking-widest text-slate-400">Status</TableHead>
                      <TableHead className="text-[10px] font-black uppercase tracking-widest text-slate-400">Timestamps</TableHead>
                      <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-400">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredBlogs.map((blog) => (
                      <TableRow key={blog.id} className="border-slate-800 hover:bg-slate-800/20 transition-colors group">
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-bold text-white group-hover:text-primary transition-colors">{blog.title}</span>
                            <span className="text-[10px] text-slate-500 font-mono italic">/{blog.slug}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="h-6 w-6 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase">
                              {blog.authorName?.charAt(0) || 'A'}
                            </div>
                            <span className="text-sm text-slate-300 font-medium">{blog.authorName}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={(blog.status as any) || 'draft'} size="sm" />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col text-[10px] font-mono text-slate-500">
                            <span>CREATED: {blog.createdAt ? format(blog.createdAt.toDate(), 'yyyy-MM-dd') : 'N/A'}</span>
                            <span>UPDATED: {blog.updatedAt ? format(blog.updatedAt.toDate(), 'yyyy-MM-dd') : 'N/A'}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" asChild className="h-8 w-8 p-0 text-slate-400 hover:text-white">
                              <Link href={`/blog/${blog.slug}`} target="_blank">
                                <ExternalLink className="h-4 w-4" />
                              </Link>
                            </Button>
                            <Button variant="ghost" size="sm" asChild className="h-8 w-8 p-0 text-slate-400 hover:text-primary">
                              <Link href={`/admin/blogs/edit?id=${blog.id}`}>
                                <Edit className="h-4 w-4" />
                              </Link>
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              onClick={() => handleDeleteBlogPost(blog.id)}
                              className="h-8 w-8 p-0 text-slate-400 hover:text-red-500"
                            >
                              <Trash className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Footer />
      </div>
    </AuthorizationGate>
  );
}
