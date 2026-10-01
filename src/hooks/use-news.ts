import { useState, useEffect } from 'react';

interface NewsItem {
  id: string;
  title: string;
  url: string;
  image_url: string;
  news_site: string;
  summary: string;
  published_at: string;
  updated_at: string;
}

export function useNews(limit: number = 10) {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchNews = async () => {
      try {
        setLoading(true);
        // Using Spaceflight News API - no API key required for basic usage
        const response = await fetch(
          `https://api.spaceflightnewsapi.net/v4/articles/?limit=${limit}&_sort=published_at:desc`
        );
        
        if (!response.ok) {
          throw new Error(`Failed to fetch news: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        setNews(data.results || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An unknown error occurred');
        setNews([]);
      } finally {
        setLoading(false);
      }
    };

    fetchNews();
  }, [limit]);

  return { news, loading, error };
}