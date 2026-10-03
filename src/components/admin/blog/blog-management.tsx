"use client";

import Image from "next/image";

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { StatusBadge, type StatusType } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Plus,
  Search,
  Filter,
  Eye,
  Edit,
  Trash2,
  Calendar,
  User,
  Tag,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { useBlogs, useCreateBlog, useUpdateBlog, useDeleteBlog } from '@/hooks/use-blogs-api';
import { useUser } from '@/firebase/auth/use-user';
import { useAuthorization } from '@/hooks/use-authorization';
import { EmorationalBlogPost } from '@/lib/blog-types';
import AuthorizationGate from '@/components/admin/AuthorizationGate';
import { BlogPostForm } from '@/components/admin/blog/blog-post-form';
import Link from 'next/link';

interface BlogManagementProps {
  className?: string;
}

export default function BlogManagement({ className }: BlogManagementProps) {
  const { user } = useUser();
  const { isAuthorized: canManageBlogs, isLoading: authLoading } = useAuthorization('canManageBlogs');
  
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [editingBlog, setEditingBlog] = useState<EmorationalBlogPost | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // API hooks
  const { blogs, loading, error, pagination, refetch } = useBlogs({
    page,
    limit: 10,
    search: searchTerm,
    autoFetch: canManageBlogs
  });

  const { createBlog, loading: creating } = useCreateBlog();
  const { updateBlog, loading: updating } = useUpdateBlog();
  const { deleteBlog, loading: deleting } = useDeleteBlog();

  // "Page Access = CRUD" Rule: If they can manage blogs, they can do everything.
  const canCreate = canManageBlogs;
  const canEdit = canManageBlogs;
  const canDelete = canManageBlogs;

  const handleCreateBlog = async (data: any) => {
    try {
      await createBlog({
        ...data,
        authorId: user?.uid,
        authorName: user?.displayName || user?.email || 'Unknown Author',
        status: data.status || 'draft',
      });
      setIsCreating(false);
      refetch();
    } catch (error) {
      console.error('Failed to create blog:', error);
    }
  };

  const handleUpdateBlog = async (data: any) => {
    if (!editingBlog) return;

    try {
      await updateBlog(editingBlog.id, data);
      setEditingBlog(null);
      refetch();
    } catch (error) {
      console.error('Failed to update blog:', error);
    }
  };

  const handleDeleteBlog = async (id: string) => {
    if (!confirm('Are you sure you want to delete this blog post?')) return;

    try {
      await deleteBlog(id);
      refetch();
    } catch (error) {
      console.error('Failed to delete blog:', error);
    }
  };

  const mapBlogStatus = (status: string): StatusType => {
    const mapping: Record<string, StatusType> = {
      'published': 'published',
      'pending_review': 'submitted-for-review',
      'draft': 'draft',
    };
    return mapping[status] || 'draft';
  };

  const formatDate = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(date));
  };

  if (authLoading) {
    return <div className="p-8 text-center animate-pulse font-mono text-xs">SYNCHRONIZING PERMISSIONS...</div>;
  }

  return (
    <AuthorizationGate permission="canManageBlogs">
      <div className={`space-y-6 ${className}`}>
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tighter text-white">Blog Management</h1>
            <p className="text-muted-foreground font-mono text-xs uppercase tracking-widest">
              Full editorial control over global transmissions
            </p>
          </div>

          {canCreate && (
            <Button onClick={() => setIsCreating(true)} className="bg-primary text-black font-black uppercase tracking-widest gap-2">
              <Plus className="h-4 w-4" />
              NEW POST
            </Button>
          )}
        </div>

        {/* Filters and Search */}
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-xl">
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-500 h-4 w-4" />
                  <Input
                    placeholder="Search blog posts..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10 bg-slate-950 border-slate-800"
                  />
                </div>
              </div>

              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-[180px] bg-slate-950 border-slate-800 font-mono text-xs uppercase font-bold">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-slate-800">
                  <SelectItem value="all">ALL STATUS</SelectItem>
                  <SelectItem value="published">PUBLISHED</SelectItem>
                  <SelectItem value="pending_review">PENDING REVIEW</SelectItem>
                  <SelectItem value="draft">DRAFT</SelectItem>
                </SelectContent>
              </Select>

              <Button variant="outline" onClick={refetch} disabled={loading} className="border-slate-800">
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Blog Posts List */}
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-xl">
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-white uppercase tracking-tight">
              <span>Mission Transmissions</span>
              {pagination && (
                <span className="text-xs font-mono text-slate-500 font-normal">
                  {pagination.total} TOTAL RECORDS
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="flex items-center gap-2 p-4 bg-red-500/10 border border-red-500/20 rounded-md mb-4">
                <AlertCircle className="h-4 w-4 text-red-500" />
                <span className="text-red-500 text-sm">{error}</span>
              </div>
            )}

            {loading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="flex items-center space-x-4">
                    <Skeleton className="h-16 w-16 rounded bg-slate-800" />
                    <div className="space-y-2 flex-1">
                      <Skeleton className="h-4 w-3/4 bg-slate-800" />
                      <Skeleton className="h-4 w-1/2 bg-slate-800" />
                    </div>
                  </div>
                ))}
              </div>
            ) : blogs.length === 0 ? (
              <div className="text-center py-20">
                <AlertCircle className="h-12 w-12 text-slate-700 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-slate-400 mb-2 uppercase">No blog posts found</h3>
                <p className="text-slate-600 text-xs font-mono uppercase">
                  {searchTerm ? 'Zero matches for current query' : 'Registry is currently empty'}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {blogs.map((blog) => (
                  <div key={blog.id} className="flex items-start space-x-4 p-4 border border-slate-800 rounded-lg hover:bg-slate-800/20 transition-colors">
                    {/* Thumbnail */}
                    <div className="flex-shrink-0">
                      {blog.thumbnailUrl ? (
                        <Image
                          src={blog.thumbnailUrl}
                          alt={blog.title}
                          width={64} height={64}
                          className="h-16 w-16 rounded object-cover border border-slate-800"
                        />
                      ) : (
                        <div className="h-16 w-16 rounded bg-slate-950 flex items-center justify-center border border-slate-800">
                          <Tag className="h-6 w-6 text-slate-700" />
                        </div>
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="text-lg font-bold text-white truncate group-hover:text-primary">
                            {blog.title}
                          </h3>
                          <p className="text-sm text-slate-400 line-clamp-2 mt-1">
                            {blog.summary || blog.body.substring(0, 150) + '...'}
                          </p>
                        </div>
                        <StatusBadge status={mapBlogStatus(blog.status)} size="sm" showTooltip={false} />
                      </div>

                      <div className="flex items-center gap-4 mt-3 text-[10px] font-mono uppercase text-slate-500">
                        <div className="flex items-center gap-1">
                          <User className="h-3 w-3" />
                          <span>{blog.authorName}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          <span>
                            {blog.publishedAt ? formatDate(blog.publishedAt) : 'DRAFT'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" asChild className="text-slate-500 hover:text-white">
                        <Link href={`/blog/${blog.slug}`} target="_blank">
                          <Eye className="h-4 w-4" />
                        </Link>
                      </Button>

                      {canEdit && (
                        <Button variant="ghost" size="sm" onClick={() => setEditingBlog(blog)} className="text-slate-500 hover:text-primary">
                          <Edit className="h-4 w-4" />
                        </Button>
                      )}

                      {canDelete && (
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteBlog(blog.id)} disabled={deleting} className="text-slate-500 hover:text-red-500">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Pagination */}
            {pagination && pagination.total > 10 && (
              <div className="flex items-center justify-between mt-6 pt-6 border-t border-slate-800">
                <div className="text-[10px] font-mono text-slate-500 uppercase">
                  Showing {(page - 1) * 10 + 1} to {Math.min(page * 10, pagination.total)} of {pagination.total} results
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(page - 1)}
                    disabled={page === 1}
                    className="border-slate-800 text-xs font-bold"
                  >
                    PREV
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(page + 1)}
                    disabled={!pagination.hasNextPage}
                    className="border-slate-800 text-xs font-bold"
                  >
                    NEXT
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Create/Edit Modal */}
        {(isCreating || editingBlog) && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <Card className="w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-slate-900 border-slate-800">
              <CardHeader className="border-b border-slate-800">
                <CardTitle className="text-white uppercase tracking-tighter">
                  {isCreating ? 'Deploy New Transmission' : 'Modify Existing Transmission'}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <BlogPostForm
                  initialData={editingBlog ? {
                    title: editingBlog.title,
                    body: editingBlog.body,
                    status: (editingBlog.status as any) || 'draft',
                    summary: editingBlog.summary,
                    slug: editingBlog.slug,
                    authorProfile: editingBlog.authorProfile as any,
                    thumbnailUrl: (editingBlog as any).thumbnailUrl,
                  } : undefined}
                  onSubmit={isCreating ? handleCreateBlog : handleUpdateBlog}
                  onCancel={() => {
                    setIsCreating(false);
                    setEditingBlog(null);
                  }}
                  submitLabel={isCreating ? 'PUBLISH' : 'UPDATE'}
                  isSubmitting={creating || updating}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </AuthorizationGate>
  );
}
