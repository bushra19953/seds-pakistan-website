/**
 * @jest-environment node
 *
 * Defect: BlogSlugPage rendered <BlogSlugPageClient related={[]} />, so
 * the Related Transmissions section never appeared even though related
 * posts were computable. The page must pass the data layer's related
 * posts through to the client component.
 *
 * The data layer and the client component are mocked; the test inspects
 * the element the server page returns.
 */

jest.mock('@/lib/server/blog-server', () => ({
  getBlogBySlug: jest.fn(),
  getRelatedBlogs: jest.fn(),
}));

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

jest.mock('../page-client', () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

import React from 'react';
import { getBlogBySlug, getRelatedBlogs } from '@/lib/server/blog-server';

// jest compiles with the classic JSX runtime (ts-jest jsx: 'react'),
// while page.tsx relies on Next's automatic runtime and never imports
// React. Provide it globally before the page module is required.
(global as any).React = React;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const BlogSlugPage = require('../page').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BlogSlugPageClient = require('../page-client').default;

const blogFixture: any = {
  id: 'post-1',
  title: 'Some Post',
  slug: 'some-post',
  categoryId: 'cat-a',
  status: 'published',
};

const relatedFixture = [
  { id: 'rel-1', title: 'Related One', slug: 'rel-1', thumbnailUrl: null, publishedAt: '2026-03-01T00:00:00.000Z' },
  { id: 'rel-2', title: 'Related Two', slug: 'rel-2', thumbnailUrl: null, publishedAt: '2026-02-01T00:00:00.000Z' },
];

beforeEach(() => {
  jest.clearAllMocks();
  (getBlogBySlug as jest.Mock).mockResolvedValue(blogFixture);
  (getRelatedBlogs as jest.Mock).mockResolvedValue(relatedFixture);
});

describe('BlogSlugPage related wiring', () => {
  it('passes the data layer related posts to the client component', async () => {
    const element: any = await BlogSlugPage({
      params: Promise.resolve({ slug: 'some-post' }),
    });

    expect(getRelatedBlogs).toHaveBeenCalledWith(blogFixture);

    // The page returns <Suspense><BlogSlugPageClient /></Suspense>.
    const clientElement = element.props.children;
    expect(clientElement.type).toBe(BlogSlugPageClient);
    expect(clientElement.props.blog).toBe(blogFixture);
    expect(clientElement.props.related).toEqual(relatedFixture);
  });

  it('still 404s when the post is not public, without asking for related posts', async () => {
    (getBlogBySlug as jest.Mock).mockResolvedValue(null);
    await expect(
      BlogSlugPage({ params: Promise.resolve({ slug: 'missing' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(getRelatedBlogs).not.toHaveBeenCalled();
  });
});
