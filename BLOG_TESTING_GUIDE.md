# Blog System Testing Guide

## Overview

This guide provides comprehensive testing procedures for the production-ready blog system, covering unit tests, integration tests, and end-to-end testing scenarios.

## Test Structure

### 1. Unit Tests

#### API Endpoints Testing
```javascript
// tests/api/blogs.test.js
import { GET, POST } from '../src/app/api/blogs/route';
import { createMocks } from 'node-mocks-http';

describe('/api/blogs', () => {
  test('GET returns paginated blogs', async () => {
    const { req, res } = createMocks({
      method: 'GET',
      query: { page: '1', limit: '10' }
    });

    await GET(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data).toHaveProperty('blogs');
    expect(data).toHaveProperty('pagination');
  });

  test('POST requires valid data', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      body: {
        title: 'Test Post',
        content: 'Test content',
        authorId: 'test-author'
      }
    });

    await POST(req, res);

    expect(res._getStatusCode()).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data).toHaveProperty('id');
  });
});
```

#### Component Testing
```javascript
// tests/components/BlogManagement.test.jsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BlogManagement } from '../src/components/admin/blog/blog-management';
import { useBlogs } from '../src/hooks/use-blogs-api';

// Mock the API hook
jest.mock('../src/hooks/use-blogs-api');

describe('BlogManagement', () => {
  test('renders blog management interface', () => {
    useBlogs.mockReturnValue({
      blogs: [],
      loading: false,
      error: null,
      pagination: null
    });

    render(<BlogManagement />);
    
    expect(screen.getByText('Blog Management')).toBeInTheDocument();
    expect(screen.getByText('New Blog Post')).toBeInTheDocument();
  });

  test('handles search functionality', async () => {
    const mockRefetch = jest.fn();
    useBlogs.mockReturnValue({
      blogs: [],
      loading: false,
      error: null,
      pagination: { total: 0 }
    });

    render(<BlogManagement />);
    
    const searchInput = screen.getByPlaceholderText('Search blog posts...');
    fireEvent.change(searchInput, { target: { value: 'test search' } });
    
    await waitFor(() => {
      expect(useBlogs).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'test search'
        })
      );
    });
  });
});
```

#### Hook Testing
```javascript
// tests/hooks/useBlogs.test.js
import { renderHook, act } from '@testing-library/react';
import { useBlogs } from '../src/hooks/use-blogs-api';

// Mock fetch
global.fetch = jest.fn();

describe('useBlogs', () => {
  beforeEach(() => {
    fetch.mockClear();
  });

  test('fetches blogs successfully', async () => {
    const mockResponse = {
      blogs: [
        {
          id: '1',
          title: 'Test Blog',
          status: 'published'
        }
      ],
      pagination: {
        page: 1,
        limit: 10,
        hasNextPage: false,
        total: 1
      }
    };

    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    });

    const { result } = renderHook(() => useBlogs({ page: 1, limit: 10 }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.blogs).toHaveLength(1);
    expect(result.current.blogs[0].title).toBe('Test Blog');
  });

  test('handles API errors', async () => {
    fetch.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useBlogs({ page: 1, limit: 10 }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.blogs).toHaveLength(0);
  });
});
```

### 2. Integration Tests

#### API Integration
```javascript
// tests/integration/blog-api.test.js
import { setupTestEnvironment, cleanupTestEnvironment } from '../test-utils';

describe('Blog API Integration', () => {
  beforeAll(async () => {
    await setupTestEnvironment();
  });

  afterAll(async () => {
    await cleanupTestEnvironment();
  });

  test('complete blog workflow', async () => {
    // 1. Create blog post
    const createResponse = await fetch('/api/blogs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Integration Test Post',
        content: 'This is a test post for integration testing',
        authorId: 'test-user-id',
        status: 'draft'
      })
    });

    expect(createResponse.ok).toBe(true);
    const createdPost = await createResponse.json();

    // 2. Update blog post
    const updateResponse = await fetch(`/api/admin/blogs/${createdPost.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'published',
        publishedAt: new Date().toISOString()
      })
    });

    expect(updateResponse.ok).toBe(true);

    // 3. Retrieve published blog
    const getResponse = await fetch('/api/blogs?page=1&limit=10');
    const data = await getResponse.json();

    expect(data.blogs).toContainEqual(
      expect.objectContaining({
        id: createdPost.id,
        status: 'published'
      })
    );
  });

  test('search and filtering', async () => {
    // Create test blogs with different categories
    await createTestBlog('Category A Blog', 'category-a');
    await createTestBlog('Category B Blog', 'category-b');

    // Test search
    const searchResponse = await fetch('/api/blogs?search=Category A');
    const searchData = await searchResponse.json();

    expect(searchData.blogs).toHaveLength(1);
    expect(searchData.blogs[0].title).toContain('Category A');

    // Test category filter
    const filterResponse = await fetch('/api/blogs?category=category-a');
    const filterData = await filterResponse.json();

    expect(filterData.blogs).toHaveLength(1);
    expect(filterData.blogs[0].categoryId).toBe('category-a');
  });
});
```

#### Frontend Integration
```javascript
// tests/integration/blog-frontend.test.js
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import BlogsPage from '../src/app/blog/page';
import { BlogErrorBoundary } from '../src/components/blog/blog-error-boundary';

describe('Blog Frontend Integration', () => {
  test('complete blog browsing workflow', async () => {
    const user = userEvent.setup();
    
    render(
      <BrowserRouter>
        <BlogErrorBoundary>
          <BlogsPage />
        </BlogErrorBoundary>
      </BrowserRouter>
    );

    // Check initial page load
    expect(screen.getByText('Blog Posts')).toBeInTheDocument();

    // Test search functionality
    const searchInput = screen.getByPlaceholderText('Search posts...');
    await user.type(searchInput, 'test search');
    
    await waitFor(() => {
      expect(searchInput).toHaveValue('test search');
    });

    // Test category filter
    const categorySelect = screen.getByText('All Categories');
    await user.click(categorySelect);
    
    await waitFor(() => {
      expect(screen.getByText('Test Category')).toBeInTheDocument();
    });
  });

  test('error boundary catches errors', () => {
    // Simulate a component error
    const ThrowError = () => {
      throw new Error('Test error');
    };

    render(
      <BrowserRouter>
        <BlogErrorBoundary>
          <ThrowError />
        </BlogErrorBoundary>
      </BrowserRouter>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Try Again')).toBeInTheDocument();
  });
});
```

### 3. End-to-End Testing

#### Playwright Configuration
```javascript
// e2e/blog.e2e.test.js
const { test, expect } = require('@playwright/test');

test.describe('Blog System E2E', () => {
  test('admin can create and publish blog post', async ({ page }) => {
    // Login as admin
    await page.goto('/auth/login');
    await page.fill('[data-testid="email"]', 'admin@test.com');
    await page.fill('[data-testid="password"]', 'password');
    await page.click('[data-testid="login-button"]');
    
    // Navigate to blog management
    await page.goto('/admin/blogs');
    await expect(page.locator('h1')).toContainText('Blog Management');
    
    // Create new blog post
    await page.click('[data-testid="new-blog-post"]');
    await page.fill('[data-testid="blog-title"]', 'E2E Test Post');
    await page.fill('[data-testid="blog-content"]', 'This is an end-to-end test post');
    await page.click('[data-testid="publish-button"]');
    
    // Verify blog post is created
    await expect(page.locator('[data-testid="blog-list"]')).toContainText('E2E Test Post');
  });

  test('public user can browse and search blogs', async ({ page }) => {
    // Visit public blog page
    await page.goto('/blog');
    await expect(page.locator('h1')).toContainText('Blog Posts');
    
    // Verify blog posts are displayed
    await expect(page.locator('[data-testid="blog-card"]')).toHaveCount.greaterThan(0);
    
    // Test search functionality
    await page.fill('[data-testid="search-input"]', 'test');
    await page.press('[data-testid="search-input"]', 'Enter');
    
    // Wait for search results
    await page.waitForSelector('[data-testid="blog-card"]');
    
    // Test category filter
    await page.selectOption('[data-testid="category-filter"]', 'technology');
    await expect(page.locator('[data-testid="blog-card"]')).toHaveCount(1);
  });
});
```

### 4. Performance Testing

#### Load Testing
```javascript
// tests/performance/blog-load.test.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 }, // Ramp up
    { duration: '5m', target: 100 }, // Stay at 100 users
    { duration: '2m', target: 200 }, // Ramp up to 200 users
    { duration: '5m', target: 200 }, // Stay at 200 users
    { duration: '2m', target: 0 },   // Ramp down
  ],
};

export default function () {
  // Test blog listing API
  const response = http.get('http://localhost:3000/api/blogs?page=1&limit=10');
  check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
    'has blog data': (r) => JSON.parse(r.body).blogs.length > 0,
  });

  sleep(1);
}
```

### 5. Security Testing

#### Authentication & Authorization
```javascript
// tests/security/auth.test.js
describe('Blog Security', () => {
  test('unauthorized users cannot access admin endpoints', async () => {
    const response = await fetch('/api/admin/blogs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid-token'
      },
      body: JSON.stringify({
        title: 'Unauthorized Post',
        content: 'This should fail'
      })
    });

    expect(response.status).toBe(401);
  });

  test('non-admin users cannot delete other users posts', async () => {
    // Login as regular user
    const authResponse = await loginAsRegularUser();
    const token = authResponse.token;

    // Try to delete another user's post
    const response = await fetch('/api/admin/blogs/some-other-user-post-id', {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    expect(response.status).toBe(403);
  });

  test('input validation prevents XSS', async () => {
    const maliciousTitle = '<script>alert("xss")</script>Test Post';
    
    const response = await fetch('/api/blogs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: maliciousTitle,
        content: 'Test content',
        authorId: 'test-user'
      })
    });

    expect(response.status).toBe(200);
    const post = await response.json();
    
    // Verify the script is properly escaped/sanitized
    expect(post.title).not.toContain('<script>');
  });
});
```

### 6. Accessibility Testing

```javascript
// tests/accessibility/blog-a11y.test.js
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import BlogsPage from '../src/app/blog/page';
import BlogManagement from '../src/components/admin/blog/blog-management';

expect.extend(toHaveNoViolations);

describe('Blog Accessibility', () => {
  test('public blog page has no accessibility violations', async () => {
    const { container } = render(
      <BlogsPage />
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('admin blog management has proper ARIA labels', () => {
    render(<BlogManagement />);
    
    expect(screen.getByLabelText('Search blog posts')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new blog post/i })).toBeInTheDocument();
  });
});
```

## Test Data Setup

### Test Database
```javascript
// tests/setup/testData.js
export const createTestBlog = async (overrides = {}) => {
  const defaultBlog = {
    title: 'Test Blog Post',
    content: 'This is a test blog post content.',
    summary: 'Test summary',
    authorId: 'test-user-id',
    authorName: 'Test User',
    status: 'published',
    tags: ['test', 'automated'],
    slug: `test-blog-${Date.now()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: new Date(),
    ...overrides
  };

  // Add to test database
  return await addDoc(collection(db, 'blogs'), defaultBlog);
};

export const createTestUser = async (role = 'member') => {
  const testUser = {
    uid: `test-user-${Date.now()}`,
    email: `test${Date.now()}@example.com`,
    displayName: 'Test User',
    role: role,
    createdAt: new Date()
  };

  await setDoc(doc(db, 'users', testUser.uid), testUser);
  return testUser;
};
```

## Test Environment Configuration

### Jest Configuration
```javascript
// jest.config.js
module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  moduleNameMapping: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/*.stories.{js,jsx,ts,tsx}',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
```

### Test Environment Variables
```bash
# .env.test
NODE_ENV=test
NEXT_PUBLIC_FIREBASE_API_KEY=test-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=test.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=test-project
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=test.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=test-sender
NEXT_PUBLIC_FIREBASE_APP_ID=test-app-id
```

## Running Tests

### Test Commands
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- --testNamePattern="BlogManagement"

# Run E2E tests
npm run test:e2e

# Run performance tests
npm run test:performance

# Run accessibility tests
npm run test:a11y
```

## Test Reporting

### Coverage Reports
- HTML coverage report: `coverage/lcov-report/index.html`
- Coverage badge in README
- Test execution summary in CI/CD

### Test Results
- JUnit XML format for CI integration
- JSON summary for custom reporting
- Screenshot artifacts for E2E tests

## Continuous Integration

### GitHub Actions Workflow
```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run test:ci
      - run: npm run test:e2e
      - uses: codecov/codecov-action@v3
```

## Manual Testing Checklist

### Admin Interface
- [ ] Create new blog post
- [ ] Edit existing blog post
- [ ] Delete blog post (soft delete)
- [ ] Change post status (draft → published)
- [ ] Upload and manage images
- [ ] Test role-based permissions
- [ ] Test search and filtering
- [ ] Test pagination

### Public Interface
- [ ] Browse blog listings
- [ ] Search functionality
- [ ] Category filtering
- [ ] Author filtering
- [ ] Pagination
- [ ] Individual blog post view
- [ ] Responsive design on mobile
- [ ] Loading states
- [ ] Error states

### API Testing
- [ ] GET /api/blogs (with and without filters)
- [ ] GET /api/blogs/latest
- [ ] GET /api/blogs/[slug]
- [ ] GET /api/authors
- [ ] GET /api/categories
- [ ] POST /api/blogs (admin only)
- [ ] PUT /api/admin/blogs/[id]
- [ ] DELETE /api/admin/blogs/[id]

### Performance Testing
- [ ] Page load times < 3 seconds
- [ ] API response times < 500ms
- [ ] Search response times < 1 second
- [ ] Image optimization working
- [ ] Database queries optimized

### Security Testing
- [ ] Authentication required for admin endpoints
- [ ] Authorization enforced for sensitive operations
- [ ] Input validation working
- [ ] XSS protection active
- [ ] CSRF protection enabled

This comprehensive testing guide ensures the blog system is thoroughly tested across all aspects of functionality, performance, security, and accessibility.