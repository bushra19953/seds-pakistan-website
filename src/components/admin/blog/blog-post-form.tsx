'use client';

import { useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { cn } from '@/lib/utils';

import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
// Removed legacy ReactQuill rich text editor which relied on ReactDOM.findDOMNode
// This caused a fatal crash in modern React/Next builds. Replaced with shadcn/ui Textarea.

// Schema for verification metrics
const verificationMetricSchema = z.object({
  label: z.string(),
  value: z.string(),
  verified: z.boolean(),
});

// Schema for technical specifications
const technicalSpecSchema = z.object({
  label: z.string(),
  value: z.string(),
  status: z.enum(['verified', 'optimal', 'excellent', 'nominal', 'perfect', 'complete']),
  unit: z.string(),
});

// Schema for engineering seal
const engineeringSealSchema = z.object({
  certifiedBy: z.string(),
  certificationLevel: z.string(),
  validatedDate: z.string(),
});

// Helper: coerce comma-separated strings into arrays
const commaSeparatedStringArray = z.preprocess((val) => {
  if (typeof val === 'string') {
    return val
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return val;
}, z.array(z.string()));

// Schema for author profile (accepts comma-separated input for achievements/credentials)
const authorProfileSchema = z.object({
  name: z.string(),
  title: z.string(),
  avatar: z.string().optional(),
  location: z.string(),
  achievements: commaSeparatedStringArray.optional().default([]),
  credentials: commaSeparatedStringArray.optional().default([]),
});

// Schema for archive documents
const archiveDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  imageUrl: z.string(),
  date: z.string(),
  author: z.string(),
  tags: z.array(z.string()),
  category: z.enum(['design', 'test', 'technical', 'historical']),
});

// Schema for future horizons
const futureHorizonSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  timeline: z.string(),
  impact: z.enum(['revolutionary', 'transformative', 'groundbreaking']),
  category: z.enum(['exploration', 'technology', 'research', 'mission']),
  progress: z.number().min(0).max(100),
});

// Schema for the unified blog form with Emorational components
export const blogPostFormSchema = z.object({
  // Basic fields
  title: z.string().min(3, 'Title must be at least 3 characters'),
  slug: z.string().min(1, 'Slug is required').optional().or(z.literal('')),
  thumbnailUrl: z
    .string()
    .url('Enter a valid URL')
    .optional()
    .or(z.literal('')),
  summary: z.string().optional().or(z.literal('')),
  body: z.string().min(10, 'Body must have some content'),
  publishDate: z.string().optional().or(z.literal('')),
  unpublishDate: z.string().optional().or(z.literal('')),
  metaTitle: z.string().optional().or(z.literal('')),
  metaDescription: z.string().optional().or(z.literal('')),
  keywords: z.string().optional().or(z.literal('')),
  newsArticleUrl: z.string().url('Enter a valid URL').optional().or(z.literal('')),
  status: z.enum(['draft', 'pending_review', 'published']),
  categoryId: z.enum(['general', 'milestone', 'news', 'blog', 'event', 'announcement']).optional(),
  
  // Emorational component fields
  launchReadiness: z.object({
    verificationMetrics: z.array(verificationMetricSchema),
  }).optional(),
  
  dataShowcase: z.object({
    technicalSpecs: z.array(technicalSpecSchema),
    engineeringSeal: engineeringSealSchema,
  }).optional(),
  
  authorProfile: authorProfileSchema.optional(),
  
  analogArchive: z.object({
    documents: z.array(archiveDocumentSchema),
  }).optional(),
  
  futureHorizons: z.object({
    horizons: z.array(futureHorizonSchema),
    primaryAction: z.object({
      text: z.string(),
      url: z.string(),
    }).optional(),
    secondaryAction: z.object({
      text: z.string(),
      url: z.string(),
    }).optional(),
  }).optional(),
});

export type BlogPostFormValues = z.infer<typeof blogPostFormSchema>;

export interface BlogPostFormProps {
  initialData?: Partial<BlogPostFormValues> | null;
  onSubmit: (values: BlogPostFormValues) => Promise<void> | void;
  submitLabel?: string;
  className?: string;
  isSubmitting?: boolean;
  onCancel?: () => void;
}

/**
 * Unified BlogPostForm used for both create and edit flows.
 * Includes SEO, scheduling, rich editor, and the missing thumbnail URL.
 */
export function BlogPostForm({
  initialData,
  onSubmit,
  submitLabel = 'Save',
  className,
  isSubmitting = false,
  onCancel,
}: BlogPostFormProps) {
  const defaultValues: BlogPostFormValues = useMemo(() => ({
    title: initialData?.title ?? '',
    slug: initialData?.slug ?? '',
    thumbnailUrl: initialData?.thumbnailUrl ?? '',
    summary: initialData?.summary ?? '',
    body: initialData?.body ?? '',
    publishDate: initialData?.publishDate ?? '',
    unpublishDate: initialData?.unpublishDate ?? '',
    metaTitle: initialData?.metaTitle ?? '',
    metaDescription: initialData?.metaDescription ?? '',
    keywords: initialData?.keywords ?? '',
    newsArticleUrl: initialData?.newsArticleUrl ?? '',
    status: initialData?.status ?? 'draft',
    categoryId: initialData?.categoryId ?? 'general',
    
    // Emorational component defaults
    launchReadiness: initialData?.launchReadiness,
    dataShowcase: initialData?.dataShowcase,
    authorProfile: initialData?.authorProfile,
    analogArchive: initialData?.analogArchive,
    futureHorizons: initialData?.futureHorizons,
  }), [initialData]);

  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<BlogPostFormValues>({
    resolver: zodResolver(blogPostFormSchema),
    defaultValues,
    mode: 'onChange',
  });

  const onFormSubmit = (values: BlogPostFormValues) => {
    onSubmit(values);
  };

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className={cn('space-y-6', className)}>
      {/* Title */}
      <div className="space-y-2">
        <Label htmlFor="title">Title</Label>
        <Input id="title" placeholder="Enter blog post title" {...register('title')} />
        {errors.title && <p className="text-sm text-red-500">{errors.title.message}</p>}
      </div>

      {/* Slug */}
      <div className="space-y-2">
        <Label htmlFor="slug">Slug (URL Path)</Label>
        <Input id="slug" placeholder="e.g., my-awesome-blog-post" {...register('slug')} />
        {errors.slug && <p className="text-sm text-red-500">{errors.slug.message}</p>}
      </div>

      {/* Thumbnail URL */}
      <div className="space-y-2">
        <Label htmlFor="thumbnailUrl">Thumbnail URL</Label>
        <Input id="thumbnailUrl" type="url" placeholder="https://example.com/image.jpg" {...register('thumbnailUrl')} />
        {errors.thumbnailUrl && <p className="text-sm text-red-500">{errors.thumbnailUrl.message}</p>}
      </div>

      {/* Summary */}
      <div className="space-y-2">
        <Label htmlFor="summary">Summary</Label>
        <Textarea id="summary" rows={3} placeholder="Short summary for list views" {...register('summary')} />
        {errors.summary && <p className="text-sm text-red-500">{errors.summary.message}</p>}
      </div>

      {/* Body - Modern replacement using shadcn/ui Textarea */}
      {/* Previously used ReactQuill (legacy) which triggered `findDOMNode is not a function`. */}
      {/* The Textarea is fully compatible with React 18+, avoiding deprecated APIs. */}
      <div className="space-y-2">
        <Label htmlFor="body">Body</Label>
        <Textarea
          id="body"
          rows={12}
          placeholder="Write your blog content here..."
          {...register('body')}
          className="min-h-[260px]"
        />
        {errors.body && <p className="text-sm text-red-500">{errors.body.message}</p>}
      </div>

      {/* Scheduling */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="publishDate">Publish Date (Optional)</Label>
          <Input id="publishDate" type="date" {...register('publishDate')} />
          {errors.publishDate && <p className="text-sm text-red-500">{errors.publishDate.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="unpublishDate">Unpublish Date (Optional)</Label>
          <Input id="unpublishDate" type="date" {...register('unpublishDate')} />
          {errors.unpublishDate && <p className="text-sm text-red-500">{errors.unpublishDate.message}</p>}
        </div>
      </div>

      {/* SEO */}
      <div className="space-y-2">
        <Label htmlFor="metaTitle">Meta Title (for SEO)</Label>
        <Input id="metaTitle" placeholder="Enter meta title" {...register('metaTitle')} />
        {errors.metaTitle && <p className="text-sm text-red-500">{errors.metaTitle.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="metaDescription">Meta Description (for SEO)</Label>
        <Textarea id="metaDescription" rows={3} placeholder="Enter meta description" {...register('metaDescription')} />
        {errors.metaDescription && <p className="text-sm text-red-500">{errors.metaDescription.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="keywords">Keywords (comma-separated)</Label>
        <Input id="keywords" placeholder="e.g., space, news, astronomy" {...register('keywords')} />
        {errors.keywords && <p className="text-sm text-red-500">{errors.keywords.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="newsArticleUrl">Related News Article URL</Label>
        <Input id="newsArticleUrl" type="url" placeholder="Enter URL of a related news article (optional)" {...register('newsArticleUrl')} />
        {errors.newsArticleUrl && <p className="text-sm text-red-500">{errors.newsArticleUrl.message}</p>}
      </div>

      {/* Category */}
      <div className="space-y-2">
        <Label htmlFor="categoryId">Category</Label>
        <Controller
          control={control}
          name="categoryId"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="general">General (no category)</SelectItem>
                <SelectItem value="milestone">Milestone</SelectItem>
                <SelectItem value="news">News</SelectItem>
                <SelectItem value="blog">Blog</SelectItem>
                <SelectItem value="event">Event</SelectItem>
                <SelectItem value="announcement">Announcement</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        {errors.categoryId && <p className="text-sm text-red-500">{errors.categoryId.message}</p>}
      </div>

      {/* Emorational Components Section */}
      <div className="border-t pt-6">
        <h3 className="text-lg font-semibold mb-4">Emorational Components (Optional)</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Configure advanced components for enhanced blog post presentation. Leave fields empty to use default values.
        </p>
        
        {/* Author Profile */}
        <div className="space-y-4 mb-6">
          <h4 className="font-medium">Author Profile Enhancement</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="authorProfile.name">Author Name</Label>
              <Input id="authorProfile.name" placeholder="Dr. Jane Smith" {...register('authorProfile.name')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="authorProfile.title">Author Title</Label>
              <Input id="authorProfile.title" placeholder="Senior Space Engineer" {...register('authorProfile.title')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="authorProfile.location">Location</Label>
              <Input id="authorProfile.location" placeholder="NASA Johnson Space Center" {...register('authorProfile.location')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="authorProfile.avatar">Avatar URL</Label>
              <Input id="authorProfile.avatar" type="url" placeholder="https://example.com/avatar.jpg" {...register('authorProfile.avatar')} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="authorProfile.achievements">Achievements (comma-separated)</Label>
            <Textarea 
              id="authorProfile.achievements" 
              rows={2} 
              placeholder="Led Mars rover mission, Published 50+ papers, NASA Excellence Award"
              {...register('authorProfile.achievements')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="authorProfile.credentials">Credentials (comma-separated)</Label>
            <Textarea 
              id="authorProfile.credentials" 
              rows={2} 
              placeholder="Ph.D. Aerospace Engineering, NASA Certified, Professional Engineer"
              {...register('authorProfile.credentials')}
            />
          </div>
        </div>

        {/* Component Data (JSON) */}
        <div className="space-y-4">
          <h4 className="font-medium">Advanced Component Data (JSON Format)</h4>
          <p className="text-sm text-muted-foreground">
            For advanced users: Configure component data in JSON format. Leave empty to use defaults.
          </p>
          
          <div className="space-y-2">
            <Label htmlFor="launchReadinessJson">Launch Readiness Metrics (JSON)</Label>
            <Textarea 
              id="launchReadinessJson" 
              rows={4} 
              placeholder='{"verificationMetrics": [{"label": "System Status", "value": "Operational", "verified": true}]}'
              className="font-mono text-sm"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="dataShowcaseJson">Data Showcase (JSON)</Label>
            <Textarea 
              id="dataShowcaseJson" 
              rows={4} 
              placeholder='{"technicalSpecs": [{"label": "Accuracy", "value": "99.7", "status": "excellent", "unit": "%"}], "engineeringSeal": {"certifiedBy": "NASA", "certificationLevel": "Mission Critical", "validatedDate": "2024-01-15"}}'
              className="font-mono text-sm"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="analogArchiveJson">Analog Archive Documents (JSON)</Label>
            <Textarea 
              id="analogArchiveJson" 
              rows={4} 
              placeholder='{"documents": [{"id": "1", "title": "Mission Blueprint", "description": "Original mission design", "imageUrl": "/archive1.jpg", "date": "1969-07-20", "author": "NASA", "tags": ["blueprint", "mission"], "category": "design"}]}'
              className="font-mono text-sm"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="futureHorizonsJson">Future Horizons (JSON)</Label>
            <Textarea 
              id="futureHorizonsJson" 
              rows={4} 
              placeholder='{"horizons": [{"id": "1", "title": "Mars Colony", "description": "Establishing permanent human presence", "timeline": "2030-2035", "impact": "revolutionary", "category": "exploration", "progress": 25}], "primaryAction": {"text": "Join Mission", "url": "/join"}, "secondaryAction": {"text": "Learn More", "url": "/mars"}}'
              className="font-mono text-sm"
            />
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Label htmlFor="status">Status</Label>
          <Controller
            control={control}
            name="status"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="pending_review">Pending Review</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="text-sm text-muted-foreground">
          <Controller
            control={control}
            name="status"
            render={({ field }) => (
              <span>
                {field.value === 'published'
                  ? 'Published'
                  : field.value === 'pending_review'
                  ? 'Pending Review'
                  : 'Draft'}
              </span>
            )}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        )}
        <Button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Saving...' : submitLabel}</Button>
      </div>
    </form>
  );
}

export default BlogPostForm;
