'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import SelectErrorBoundary from '@/components/blog/select-error-boundary';
import { useCategories, useAuthors } from '@/hooks/use-blogs-api';

export default function FiltersClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || 'all');
  const [selectedAuthor, setSelectedAuthor] = useState(searchParams.get('author') || 'all');

  // OPTIMIZATION: Defer filter data loading to prioritize blog content
  const [shouldLoadFilters, setShouldLoadFilters] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShouldLoadFilters(true), 500);
    return () => clearTimeout(timer);
  }, []);

  // Only load categories/authors after delay - pass enabled=false to skip fetching
  const { categories } = useCategories(shouldLoadFilters);
  const { authors, loading: authorsLoading, error: authorsError } = useAuthors(undefined, shouldLoadFilters);

  // Show loading while waiting for deferred load or actual loading
  const effectiveAuthorsLoading = !shouldLoadFilters || authorsLoading;

  // OPTIMIZATION: Debounce URL updates to avoid excessive router.push calls
  const debounceRef = useRef<any>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams();
      if (searchTerm) params.set('search', searchTerm);
      if (selectedCategory && selectedCategory !== 'all') params.set('category', selectedCategory);
      if (selectedAuthor && selectedAuthor !== 'all') params.set('author', selectedAuthor);
      router.push(params.toString() ? `/blog?${params.toString()}` : '/blog', { scroll: false });
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchTerm, selectedCategory, selectedAuthor, router]);

  const clearFilters = () => {
    setSearchTerm('');
    setSelectedCategory('all');
    setSelectedAuthor('all');
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="text-lg font-semibold mb-4">Filters</h2>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-2 block">Search</label>
            <Input
              placeholder="Search posts..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-2 block">Category</label>
            <SelectErrorBoundary type="category" label="Category">
              <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="All Categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories && categories.length > 0 ? (
                    categories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name || 'Unnamed Category'} ({category.postCount || 0})
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__no-categories" disabled>
                      No categories available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </SelectErrorBoundary>
          </div>
          <div>
            <label className="text-sm font-medium mb-2 block">Author</label>
            <SelectErrorBoundary type="author" label="Author">
              <Select
                value={selectedAuthor}
                onValueChange={setSelectedAuthor}
                disabled={authorsLoading || authorsError !== null}
              >
                <SelectTrigger>
                  <SelectValue placeholder={
                    authorsLoading
                      ? 'Loading authors...'
                      : authorsError
                        ? 'Failed to load authors'
                        : 'All Authors'
                  } />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Authors</SelectItem>
                  {Array.isArray(authors) && authors.length > 0 ? (
                    authors.map((author) => (
                      <SelectItem key={author.id} value={author.id}>
                        {author.name || 'Unknown Author'} ({author.postCount || 0} posts)
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__empty" disabled>
                      No authors available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </SelectErrorBoundary>
          </div>
          {(searchTerm || selectedCategory !== 'all' || selectedAuthor !== 'all') && (
            <Button variant="outline" onClick={clearFilters} className="w-full">
              Clear Filters
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
