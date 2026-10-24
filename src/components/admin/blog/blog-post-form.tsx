'use client';

import React, { useMemo, useState, type ChangeEvent } from 'react';
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

// Schema for the launch readiness block
const launchReadinessSchema = z.object({
  verificationMetrics: z.array(verificationMetricSchema),
});

// Schema for the data showcase block
const dataShowcaseSchema = z.object({
  technicalSpecs: z.array(technicalSpecSchema),
  engineeringSeal: engineeringSealSchema,
});

// Schema for the analog archive block
const analogArchiveSchema = z.object({
  documents: z.array(archiveDocumentSchema),
});

// Schema for the future horizons block
const futureHorizonsSchema = z.object({
  horizons: z.array(futureHorizonSchema),
  primaryAction: z.object({
    text: z.string(),
    url: z.string(),
  }).optional(),
  secondaryAction: z.object({
    text: z.string(),
    url: z.string(),
  }).optional(),
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
  launchReadiness: launchReadinessSchema.optional(),

  dataShowcase: dataShowcaseSchema.optional(),

  authorProfile: authorProfileSchema.optional(),

  analogArchive: analogArchiveSchema.optional(),

  futureHorizons: futureHorizonsSchema.optional(),
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

// The four "Advanced Component Data" textareas hold raw JSON for these
// structured fields. The text lives outside react-hook-form (which holds the
// parsed form values) and is parsed and validated at submit time, so what an
// author types can never be silently dropped.
export const componentJsonFieldKeys = [
  'launchReadiness',
  'dataShowcase',
  'analogArchive',
  'futureHorizons',
] as const;
export type ComponentJsonFieldKey = (typeof componentJsonFieldKeys)[number];

export type ComponentJsonTexts = Record<ComponentJsonFieldKey, string>;
export type ComponentJsonErrors = Partial<Record<ComponentJsonFieldKey, string>>;

const componentJsonSchemas: Record<ComponentJsonFieldKey, z.ZodTypeAny> = {
  launchReadiness: launchReadinessSchema,
  dataShowcase: dataShowcaseSchema,
  analogArchive: analogArchiveSchema,
  futureHorizons: futureHorizonsSchema,
};

/** Build the initial textarea contents from stored component data (edit prefill). */
export function componentJsonTextsFromInitialData(
  initialData?: Partial<BlogPostFormValues> | null,
): ComponentJsonTexts {
  const stringify = (value: unknown) => (value ? JSON.stringify(value, null, 2) : '');
  return {
    launchReadiness: stringify(initialData?.launchReadiness),
    dataShowcase: stringify(initialData?.dataShowcase),
    analogArchive: stringify(initialData?.analogArchive),
    futureHorizons: stringify(initialData?.futureHorizons),
  };
}

/**
 * Parse the raw JSON textarea contents into structured component values.
 * An empty (or whitespace-only) box means "field absent": no value and no
 * error, exactly as if the component had never been configured. Text that is
 * not valid JSON, or that does not match the component's expected shape,
 * produces a field-level error so the submit can be blocked with the error
 * shown next to the box instead of the typed data being thrown away.
 */
export function parseComponentJsonFields(texts: ComponentJsonTexts): {
  values: Partial<Pick<BlogPostFormValues, ComponentJsonFieldKey>>;
  errors: ComponentJsonErrors;
} {
  const values: Partial<Pick<BlogPostFormValues, ComponentJsonFieldKey>> = {};
  const errors: ComponentJsonErrors = {};

  for (const key of componentJsonFieldKeys) {
    const raw = (texts[key] ?? '').trim();
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors[key] = `Invalid JSON: ${err instanceof Error ? err.message : 'could not be parsed'}`;
      continue;
    }

    const result = componentJsonSchemas[key].safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first?.path?.length ? `${first.path.join('.')}: ` : '';
      errors[key] = `Does not match the expected format: ${path}${first?.message ?? 'invalid data'}`;
      continue;
    }

    values[key] = result.data;
  }

  return { values, errors };
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

  // Raw JSON for the Advanced Component Data textareas, prefilled from any
  // stored component data so an edit round-trip is lossless.
  const [jsonTexts, setJsonTexts] = useState<ComponentJsonTexts>(() =>
    componentJsonTextsFromInitialData(initialData),
  );
  const [jsonErrors, setJsonErrors] = useState<ComponentJsonErrors>({});

  const handleJsonTextChange =
    (key: ComponentJsonFieldKey) =>
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const { value } = event.target;
      setJsonTexts((prev) => ({ ...prev, [key]: value }));
      setJsonErrors((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    };

  const onFormSubmit = (values: BlogPostFormValues) => {
    const { values: componentValues, errors: componentErrors } =
      parseComponentJsonFields(jsonTexts);
    setJsonErrors(componentErrors);
    if (Object.keys(componentErrors).length > 0) {
      // Block the submit: typed JSON is never silently discarded.
      return;
    }

    const nextValues: BlogPostFormValues = { ...values };
    if (componentValues.launchReadiness !== undefined) {
      nextValues.launchReadiness = componentValues.launchReadiness;
    } else {
      delete nextValues.launchReadiness;
    }
    if (componentValues.dataShowcase !== undefined) {
      nextValues.dataShowcase = componentValues.dataShowcase;
    } else {
      delete nextValues.dataShowcase;
    }
    if (componentValues.analogArchive !== undefined) {
      nextValues.analogArchive = componentValues.analogArchive;
    } else {
      delete nextValues.analogArchive;
    }
    if (componentValues.futureHorizons !== undefined) {
      nextValues.futureHorizons = componentValues.futureHorizons;
    } else {
      delete nextValues.futureHorizons;
    }
    onSubmit(nextValues);
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
              <Input id="authorProfile.name" placeholder="Full name of the author" {...register('authorProfile.name')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="authorProfile.title">Author Title</Label>
              <Input id="authorProfile.title" placeholder="Author's role or title" {...register('authorProfile.title')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="authorProfile.location">Location</Label>
              <Input id="authorProfile.location" placeholder="City, institution" {...register('authorProfile.location')} />
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
              placeholder="Comma-separated list of the author's achievements"
              {...register('authorProfile.achievements')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="authorProfile.credentials">Credentials (comma-separated)</Label>
            <Textarea 
              id="authorProfile.credentials" 
              rows={2} 
              placeholder="Comma-separated list of the author's credentials"
              {...register('authorProfile.credentials')}
            />
          </div>
        </div>

        {/* Component Data (JSON) */}
        <div className="space-y-4">
          <h4 className="font-medium">Advanced Component Data (JSON Format)</h4>
          <p className="text-sm text-muted-foreground">
            For advanced users: Configure component data in JSON format. Leave a box empty to omit
            that component. If a box contains invalid JSON, saving is blocked and the error is
            shown under the box, so typed data is never lost silently.
          </p>

          <div className="space-y-2">
            <Label htmlFor="launchReadinessJson">Launch Readiness Metrics (JSON)</Label>
            <Textarea
              id="launchReadinessJson"
              rows={4}
              value={jsonTexts.launchReadiness}
              onChange={handleJsonTextChange('launchReadiness')}
              placeholder='{"verificationMetrics": [{"label": "Metric name", "value": "Metric value", "verified": true}]}'
              className="font-mono text-sm"
            />
            {jsonErrors.launchReadiness && (
              <p className="text-sm text-red-500">{jsonErrors.launchReadiness}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="dataShowcaseJson">Data Showcase (JSON)</Label>
            <Textarea
              id="dataShowcaseJson"
              rows={4}
              value={jsonTexts.dataShowcase}
              onChange={handleJsonTextChange('dataShowcase')}
              placeholder='{"technicalSpecs": [{"label": "Spec name", "value": "0", "status": "nominal", "unit": "units"}], "engineeringSeal": {"certifiedBy": "Certifying body", "certificationLevel": "Level", "validatedDate": "YYYY-MM-DD"}}'
              className="font-mono text-sm"
            />
            {jsonErrors.dataShowcase && (
              <p className="text-sm text-red-500">{jsonErrors.dataShowcase}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="analogArchiveJson">Analog Archive Documents (JSON)</Label>
            <Textarea
              id="analogArchiveJson"
              rows={4}
              value={jsonTexts.analogArchive}
              onChange={handleJsonTextChange('analogArchive')}
              placeholder='{"documents": [{"id": "1", "title": "Document title", "description": "Short description", "imageUrl": "/images/example.jpg", "date": "YYYY-MM-DD", "author": "Author name", "tags": ["tag"], "category": "design"}]}'
              className="font-mono text-sm"
            />
            {jsonErrors.analogArchive && (
              <p className="text-sm text-red-500">{jsonErrors.analogArchive}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="futureHorizonsJson">Future Horizons (JSON)</Label>
            <Textarea
              id="futureHorizonsJson"
              rows={4}
              value={jsonTexts.futureHorizons}
              onChange={handleJsonTextChange('futureHorizons')}
              placeholder='{"horizons": [{"id": "1", "title": "Horizon title", "description": "Short description", "timeline": "YYYY-YYYY", "impact": "transformative", "category": "research", "progress": 0}]}'
              className="font-mono text-sm"
            />
            {jsonErrors.futureHorizons && (
              <p className="text-sm text-red-500">{jsonErrors.futureHorizons}</p>
            )}
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
