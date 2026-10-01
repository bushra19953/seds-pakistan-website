# Blog Debugging Guide

This document explains how to debug and fix issues with blog post visibility on the SEDS Pakistan website.

## Current Issues

1. Published blog posts are not appearing on the public `/blog` page
2. There may be legacy blog posts using the old `published` field instead of the new `status` field

## Debugging Steps

### 1. Check Current Blog Data

Visit the debug page at `/debug-blogs` to see what blog data exists in the database.

### 2. Create a New Blog Post

1. Log in as an admin or blog writer
2. Go to `/admin/blogs/new`
3. Create a new blog post
4. Set the status to "Published"
5. Save the post

### 3. Check if the Blog Post Appears

Visit the public `/blog` page to see if the newly created blog post appears.

## Migration of Legacy Blog Posts

If you have existing blog posts that were created before the status field was added, you may need to run the migration script:

```bash
node migrate-blog-status.js
```

This script will:
- Find all blog posts with `published = true` and add `status = 'published'`
- Find all blog posts with `published = false` and add `status = 'draft'`

## Code Changes Made

### 1. Fixed Blog Creation Page

Fixed the "Invalid hook call" error in `/admin/blogs/new/page.tsx` by properly using the `useEnhancedToast` hook.

### 2. Updated Public Blog Page

Updated `/blog/page.tsx` to:
- Query for blog posts with `status == 'published'`
- Fall back to the old `published == true` field if no posts are found
- Show detailed debugging information
- Filter results to only show published posts

### 3. Added Navigation Link

Added a "Blog" link to the main navigation header in `/components/layout/header.tsx`.

## Troubleshooting

### If No Blog Posts Appear

1. Check the browser console for errors
2. Verify that blog posts have been created with `status = 'published'`
3. Check the Firebase Firestore database directly to see what data exists
4. Run the migration script if you have legacy blog posts

### If There Are Errors

1. Check the error message displayed on the blog page
2. Look at the debug information for details about what queries were run
3. Verify that the Firebase configuration is correct
4. Check that the Firestore security rules allow public read access to published blogs

## Expected Behavior

Once a blog post is created with `status = 'published'`, it should appear on the public `/blog` page. The page should show:
- A grid of blog post cards
- Each card with the title, author, date, and excerpt
- Clicking a card should take you to the full blog post