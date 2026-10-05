"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from 'next/link';
import Image from 'next/image';
import { Skeleton } from "@/components/ui/skeleton";
import { Newspaper, Rocket, ExternalLink, Calendar, User, BookOpen } from "lucide-react";
import { useNews } from "@/hooks/use-news";
import { useLatestBlogs } from "@/hooks/use-blogs";

interface CombinedItem {
  id: string;
  title: string;
  url: string;
  image_url?: string;
  source: string; // news_site or author
  summary: string;
  published_at: string; // ISO string for consistent sorting
  type: "news" | "blog";
  news_article_url?: string;
  author_uid?: string; // Add this for blog posts
}

export default function NewsAndBlogsSection() {
  const { news, loading: loadingNews, error: errorNews } = useNews(3);
  const { blogs, loading: loadingBlogs, error: errorBlogs } = useLatestBlogs(3);
  const [visibleItems, setVisibleItems] = useState(3);

  const loading = loadingNews || loadingBlogs;
  const error = errorNews || errorBlogs;

  const combinedItems: CombinedItem[] = [
    ...news.map(item => ({
      id: item.id,
      title: item.title,
      url: item.url,
      image_url: item.image_url,
      source: item.news_site,
      summary: item.summary,
      published_at: item.published_at,
      type: "news" as const,
    })),
    ...blogs.map(item => ({
      id: item.id,
      title: item.title,
      url: `/blog/${item.slug}`, // Use slug from the BlogPost
      image_url: item.thumbnailUrl, // Use thumbnailUrl
      source: item.authorName || 'Unknown Author', // Use authorName from the BlogPost
      summary: item.summary || item.body.substring(0, 150) + '...', // Use summary or truncate body
      published_at: item.publishedAt || new Date().toISOString(),
      type: "blog" as const,
    })),
  ].sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

  // If API fails, fallback to static data (only for news, blogs should be fetched from Firestore)
  const displayItems = combinedItems.length > 0 ? combinedItems : [
    {
      id: "1",
      title: "SEDS-ROCKETRY team announces successful test fire of their new hybrid engine.",
      url: "#",
      image_url: "",
      source: "SEDS Pakistan",
      summary: "Our rocketry team has achieved a major milestone with their hybrid engine test.",
      published_at: new Date().toISOString(),
      type: "news"
    },
    {
      id: "2",
      title: "NASA confirms liquid water on Mars, opening new possibilities for future missions.",
      url: "#",
      image_url: "",
      source: "Space News",
      summary: "Latest findings from the Perseverance rover indicate presence of liquid water.",
      published_at: new Date().toISOString(),
      type: "news"
    },
    {
      id: "3",
      title: "SEDS Pakistan to host National Space Hackathon in collaboration with industry leaders.",
      url: "#",
      image_url: "",
      source: "SEDS Pakistan",
      summary: "Join us for a 48-hour hackathon focused on solving real space challenges.",
      published_at: new Date().toISOString(),
      type: "news"
    }
  ];

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  return (
    <section
      id="news-and-blogs"
      className="py-8 bg-black/20 border-y-2 border-primary/50 backdrop-blur-sm"
      aria-labelledby="news-blogs-heading"
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-6">
          <div className="flex items-center gap-2 mb-4 md:mb-0">
            <Newspaper className="h-6 w-6 text-primary" />
            <h2
              id="news-blogs-heading"
              className="font-accent text-lg font-bold tracking-wider text-primary uppercase"
            >
              Latest Updates
            </h2>
          </div>
          {displayItems.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="font-accent text-primary hover:bg-primary/10"
              asChild
            >
              <Link href="/blog" aria-label="View all blog posts">
                View All
              </Link>
            </Button>
          )}
        </div>

        {error && (
          <div
            className="mb-4 p-4 bg-destructive/10 text-destructive rounded-md"
            role="alert"
            aria-live="polite"
          >
            <p>Failed to load updates: {error}. Showing cached content.</p>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <Card
                key={i}
                className="bg-card/80 backdrop-blur-sm border-accent/20"
                aria-busy="true"
                aria-label="Loading news and blog content"
              >
                <CardContent className="p-4">
                  <Skeleton className="h-40 w-full rounded-md mb-4" />
                  <Skeleton className="h-4 w-3/4 mb-2" />
                  <Skeleton className="h-4 w-1/2 mb-3" />
                  <div className="flex justify-between items-center">
                    <Skeleton className="h-3 w-1/3" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {displayItems.slice(0, visibleItems).map((item) => (
              <Card
                key={`${item.type}-${item.id}`}
                className="bg-card/80 backdrop-blur-sm border-accent/20 hover:border-primary transition-all duration-300 group"
              >
                <CardContent className="p-4">
                  {item.image_url ? (
                    <div className="relative h-40 rounded-md overflow-hidden mb-4 bg-card">
                      <Image
                        src={item.image_url}
                        alt={item.title}
                        width={800}
                        height={600}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        // Drive thumbnails fail through the Next.js image optimizer
                        // (server-side fetch gets blocked, returns 502). Load them
                        // directly with a plain img tag instead.
                        unoptimized={item.image_url.includes('drive.google.com')}
                      />
                    </div>
                  ) : (
                    <div
                      className="h-40 bg-gradient-to-br from-primary/10 to-accent/10 rounded-md mb-4 flex items-center justify-center"
                      aria-label="No image available for this item"
                    >
                      {item.type === "news" ? (
                        <Newspaper className="h-12 w-12 text-primary/30" aria-hidden="true" />
                      ) : (
                        <BookOpen className="h-12 w-12 text-primary/30" aria-hidden="true" />
                      )}
                    </div>
                  )}
                  <h3 className="font-headline font-bold text-lg mb-2 line-clamp-2 group-hover:text-primary transition-colors">
                    {item.title}
                  </h3>
                  <p className="font-body text-muted-foreground text-sm mb-3 line-clamp-2 text-justify">
                    {item.summary}
                  </p>
                  <div className="flex justify-between items-center text-xs font-body text-muted-foreground">
                    <div className="flex items-center gap-1">
                      {item.type === "news" ? (
                        <User className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <BookOpen className="h-3 w-3" aria-hidden="true" />
                      )}
                      <span>{item.source}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" aria-hidden="true" />
                      <span>{formatDate(item.published_at)}</span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full mt-3 font-accent text-primary hover:bg-primary/10 group-hover:bg-primary/10"
                    asChild
                  >
                    <a
                      href={item.url}
                      target={item.type === "news" ? "_blank" : "_self"}
                      rel={item.type === "news" ? "noopener noreferrer" : undefined}
                      aria-label={`Read more about ${item.title}`}
                    >
                      {item.type === "news" ? "Read News" : "Read Blog"} <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
                    </a>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
