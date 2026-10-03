"use client";

import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowRight, Calendar, Award } from 'lucide-react';
import Link from 'next/link';
import { useMilestonePosts } from '@/hooks/use-milestone-posts';
import { formatDate } from '@/lib/utils';
import { useUser } from '@/firebase';

export default function InteractiveMilestoneTimeline() {
  const { user, role } = useUser();
  const { milestones, loading, error } = useMilestonePosts(7); // Latest 7 milestones

  // CRITICAL FIX: Move all hooks to the top level - no conditional returns
  // Handle zero state and error state in JSX, not by returning early
  const sortedMilestones = useMemo(() => {
    return [...(milestones || [])].sort((a, b) => {
      const dateA = new Date(a.publishedAt || a.createdAt).getTime();
      const dateB = new Date(b.publishedAt || b.createdAt).getTime();
      return dateB - dateA; // Newest first
    });
  }, [milestones]);
  
  // Check admin access
  const hasAdminAccess = user && role && (
    role === 'superadmin' ||
    role === 'president_national' ||
    role === 'vice_president' ||
    role === 'general_secretary' ||
    role === 'marketing_head' ||
    role === 'advisor' ||
    role === 'projects_director' ||
    role === 'chair_projects' ||
    role === 'hr_director' ||
    role === 'treasurer' ||
    role === 'chair_events'
  );

  return (
    <section 
      id="milestones" 
      className="py-20 md:py-32 bg-gradient-to-b from-background to-black/20"
      aria-labelledby="milestones-heading"
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-12">
          <h2 
            id="milestones-heading"
            className="text-4xl md:text-5xl font-bold mb-4 text-foreground"
          >
            Our Journey Through Milestones
          </h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
            Discover the key achievements that have shaped SEDS Pakistan&apos;s mission in advancing space exploration and education.
          </p>
        </div>

        {error ? (
          // Error state - still render the section but with error message
          <div className="text-center py-12">
            <p className="text-destructive mb-2 font-medium">
              ⚠️ Error loading milestone timeline
            </p>
            <p className="text-muted-foreground">
              Milestone timeline is temporarily unavailable. Please check back later.
            </p>
          </div>
        ) : loading ? (
          // Loading skeleton
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[...Array(6)].map((_, index) => (
              <Card key={index} className="animate-pulse">
                <CardHeader>
                  <div className="h-4 bg-gray-200 rounded w-24 mb-3"></div>
                  <div className="h-6 bg-gray-200 rounded w-full mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                </CardHeader>
                <CardContent>
                  <div className="h-4 bg-gray-200 rounded w-full mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-2/3"></div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : !sortedMilestones || sortedMilestones.length === 0 ? (
          // Zero state - no milestones available
          <div className="text-center py-12">
            <p className="text-muted-foreground">
              No milestones to display yet. Check back soon for our latest achievements!
            </p>
          </div>
        ) : (
          // Normal state - render milestones
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {sortedMilestones.map((milestone, index) => {
              const milestoneDate = new Date(milestone.publishedAt || milestone.createdAt);
              const displayYear = milestoneDate.getFullYear();
              const displayDate = formatDate(milestoneDate);

              return (
                <Card
                  key={milestone.id}
                  className="bg-card/80 backdrop-blur-sm border-border/50 hover:border-primary/50 transition-all duration-300 group"
                >
                  <CardHeader className="pb-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="flex items-center gap-1 text-xs font-accent text-primary font-semibold">
                        <Award className="h-3 w-3" />
                        {displayYear}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        {displayDate}
                      </div>
                    </div>
                    
                    <CardTitle className="text-lg line-clamp-2 group-hover:text-primary transition-colors">
                      {milestone.title}
                    </CardTitle>
                    
                    {milestone.summary && (
                      <CardDescription className="line-clamp-3">
                        {milestone.summary}
                      </CardDescription>
                    )}
                  </CardHeader>
                  
                  <CardContent className="pt-0">
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-muted-foreground">
                        {milestone.authorName || 'SEDS Pakistan Team'}
                      </div>
                      
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="text-xs"
                      >
                        <Link href={`/blog/${milestone.slug || milestone.id}`}>
                          Read More <ArrowRight className="h-3 w-3 ml-1" />
                        </Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Call to Action */}
        <div className="flex justify-center mt-12">
          <Button 
            asChild 
            size="lg" 
            className="font-accent tracking-widest uppercase text-base hover:text-glow transition-all pulse-glow"
            aria-label="View all milestones"
          >
            <Link href="/timelines">
              View All Milestones <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
            </Link>
          </Button>
        </div>

        {/* Admin Edit Link - Only visible to admin users */}
        {hasAdminAccess && (
          <div className="text-center mt-6">
            <a
              href="/admin/blogs/new"
              className="text-xs text-muted-foreground hover:text-primary underline underline-offset-4 transition-colors"
            >
              📝 Add New Milestone
            </a>
          </div>
        )}
      </div>
    </section>
  );
}