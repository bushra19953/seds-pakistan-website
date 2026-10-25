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
import { collection, query, orderBy } from 'firebase/firestore';
import Link from 'next/link';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';
import Footer from '@/components/layout/footer';
import { useClientSupaSurface } from '@/lib/client-supa-flags';

export default function BlogAdminPage() {
  const { user, role, isLoading: userLoading } = useUser();
  const { isAuthorized: canManageBlogs, isLoading: authLoading } = useAuthorization('canManageBlogs');
  const router = useRouter();
  const firestore = useFirestore();
  const { toast } = useToast();

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  // One-shot fetch + manual refresh (listener census B1 -> approach (d)):
  // the previous no-limit onSnapshot listener is replaced by a single
  // getDocs read; bumping refreshNonce rebuilds the query identity, which
  // makes useCollection fetch again.
  const [refreshNonce, setRefreshNonce] = useState(0);

  const blogsQuery = useMemo(() => {
    if (!firestore) return null;
    return query(collection(firestore, 'blogs'), orderBy('createdAt', 'desc'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firestore, refreshNonce]);

  const liveAdminOn = useClientSupaSurface('live-admin');
  const { data: blogs, loading: blogsLoading, error } = useCollection(blogsQuery, { listen: !liveAdminOn });

  const filteredBlogs = useMemo(() => {
    if (!blogs) return [];
    return blogs.filter(blog => {
      const matchesSearch = blog.title?.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          blog.authorName?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === 'all' || blog.status === statusFilter;
      // Soft-deleted posts stay hidden everywhere except the ARCHIVED view:
      // an archived post (the REST DELETE terminal state, which also sets
      // `deleted`) must remain findable there so it can be opened in the
      // edit form and restored to a live status.
      const isNotDeleted = !blog.deleted || (statusFilter === 'archived' && blog.status === 'archived');
      return matchesSearch && matchesStatus && isNotDeleted;
    });
  }, [blogs, searchTerm, statusFilter]);

  const handleDeleteBlogPost = async (id: string) => {
    if (!confirm('Are you sure you want to delete this blog post? This action is irreversible.')) return;

    try {
      // Use the API for deletion to ensure backend enforcement.
      // The item route is the plural "blogs" path (/api/admin/blogs/[id]);
      // a singular variant does not exist and 404s with an HTML body.
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
        // Surface the server's real error message. The body is not
        // guaranteed to be JSON (an unmatched route returns HTML), so a
        // failed parse must fall back to the HTTP status, never throw
        // the JSON parse error itself to the toast.
        let message = `Failed to delete blog post (HTTP ${res.status}).`;
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch {
          // Non-JSON error body: keep the HTTP status fallback above.
        }
        throw new Error(message);
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
            <h1 className="text-4xl font-black text-foreground uppercase tracking-tighter flex items-center gap-3">
               Blog Command Center
            </h1>
            <p className="text-muted-foreground font-mono text-xs uppercase tracking-widest mt-1">Global editorial control and content management</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="border-slate-800 font-black uppercase tracking-widest"
              onClick={() => setRefreshNonce((n) => n + 1)}
              title="Refresh the blog list (one-shot fetch)"
            >
              <RefreshCw className="h-4 w-4 mr-2" /> REFRESH
            </Button>
            <Button asChild className="bg-primary text-black font-black uppercase tracking-widest">
              <Link href="/admin/blog/new">
                <Plus className="h-4 w-4 mr-2" /> CREATE POST
              </Link>
            </Button>
          </div>
        </div>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-xl">
          <CardContent className="p-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
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
                    const options = ['all', 'published', 'pending_review', 'draft', 'archived'];
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
                <CardTitle className="text-xl font-bold uppercase tracking-tight text-foreground">Transmission Registry</CardTitle>
                <CardDescription className="text-[10px] uppercase font-mono text-muted-foreground">{filteredBlogs.length} Active Records Filtered</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {blogsLoading ? (
              <div className="p-8 text-center animate-pulse font-mono text-xs">SCANNING DATABASE...</div>
            ) : filteredBlogs.length === 0 ? (
              <div className="p-20 text-center">
                <p className="text-muted-foreground font-mono text-xs italic tracking-widest">No blog posts found matching your criteria.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-slate-950/50">
                    <TableRow className="hover:bg-transparent border-slate-800">
                      <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Article Identity</TableHead>
                      <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Author</TableHead>
                      <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Status</TableHead>
                      <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Timestamps</TableHead>
                      <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredBlogs.map((blog) => (
                      <TableRow key={blog.id} className="border-slate-800 hover:bg-slate-800/20 transition-colors group">
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-bold text-foreground group-hover:text-primary transition-colors">{blog.title}</span>
                            <span className="text-[10px] text-muted-foreground font-mono italic">/{blog.slug}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="h-6 w-6 rounded-full bg-muted border border-slate-700 flex items-center justify-center text-[10px] font-bold text-muted-foreground uppercase">
                              {blog.authorName?.charAt(0) || 'A'}
                            </div>
                            <span className="text-sm text-muted-foreground font-medium">{blog.authorName}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={(blog.status as any) || 'draft'} size="sm" />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col text-[10px] font-mono text-muted-foreground">
                            <span>CREATED: {blog.createdAt ? format(blog.createdAt.toDate(), 'yyyy-MM-dd') : 'N/A'}</span>
                            <span>UPDATED: {blog.updatedAt ? format(blog.updatedAt.toDate(), 'yyyy-MM-dd') : 'N/A'}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" asChild className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground">
                              <Link href={`/blog/${blog.slug}`} target="_blank">
                                <ExternalLink className="h-4 w-4" />
                              </Link>
                            </Button>
                            <Button variant="ghost" size="sm" asChild className="h-8 w-8 p-0 text-muted-foreground hover:text-primary">
                              <Link href={`/admin/blog/edit?id=${blog.id}`}>
                                <Edit className="h-4 w-4" />
                              </Link>
                            </Button>
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              onClick={() => handleDeleteBlogPost(blog.id)}
                              className="h-8 w-8 p-0 text-muted-foreground hover:text-red-500"
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
