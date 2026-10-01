"use client";

import React, { useState, useEffect, Suspense, useMemo } from "react";
import { renderMarkdownSafe } from '@/lib/markdown';
import { useDoc, useCollection, useFirestore, useUser } from '@/firebase';
import { collection, query, where, getDocs, doc } from 'firebase/firestore';
import { getProjectBySlugOrId } from '@/lib/firebase/firestore';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { Users, Github, BookOpen, ExternalLink } from 'lucide-react';
import Link from 'next/link';

function MemberAvatar({ memberId }: { memberId: string }) {
  const firestore = useFirestore();
  const userDocRef = useMemoFirebase(() => doc(firestore, 'users', memberId), [firestore, memberId]);
  const { data: userProfile, loading } = useDoc(userDocRef);

  if (loading) {
    return <Skeleton className="h-10 w-10 rounded-full" />;
  }

  if (!userProfile) return null;

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'U';
    return name.split(' ').map((n) => n[0]).join('');
  };

  return (
    <Link href={`/profile/unified/${memberId}`} passHref>
      <Avatar className="h-10 w-10 border-2 border-transparent hover:border-primary transition-colors cursor-pointer">
        <AvatarImage src={userProfile.photoURL} alt={userProfile.displayName} />
        <AvatarFallback>{getInitials(userProfile.displayName)}</AvatarFallback>
      </Avatar>
    </Link>
  );
}

function ProjectDetailContent() {
  const searchParams = useSearchParams();
  const slug = searchParams.get('slug');
  const firestore = useFirestore();

  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const fetchProjectBySlug = async () => {
      if (!slug) return;
      setLoading(true);
      try {
        const result = await getProjectBySlugOrId(firestore, slug);
        setProject(result);
      } catch (error) {
        console.error("Error fetching project by slug:", error);
        setProject(null);
      } finally {
        setLoading(false);
      }
    };
    fetchProjectBySlug();
  }, [slug, firestore]);

  // RULES OF HOOKS FIX:
  // Hooks must run in the same order on every render.
  // These memoized computations previously appeared after early returns,
  // which caused React to sometimes skip them and later call them,
  // triggering "Rendered more hooks than during the previous render".
  // Move them BEFORE any conditional returns and gate logic INSIDE
  // the memo callbacks instead.

  // Convert Markdown/HTML description to sanitized HTML once project is loaded
  const sanitizedHtml: string = useMemo(() => {
    const text = (typeof project?.description === 'string' && project.description)
      || (typeof project?.summary === 'string' && project.summary)
      || '';
    return renderMarkdownSafe(text);
  }, [project]);

  // Helper to clean and validate external URLs
  const cleanUrl = (val?: string): string | undefined => {
    if (!val || typeof val !== 'string') return undefined;
    const cleaned = val.trim().replace(/[`]/g, '').replace(/[)\s]+$/g, '');
    try {
      const u = new URL(cleaned);
      return u.toString();
    } catch {
      return undefined;
    }
  };

  // Normalize team members shape (support legacy `members` and new `team`)
  const teamMembers: string[] = Array.isArray(project?.team) && project.team.length
    ? project.team
    : (Array.isArray(project?.members) ? project.members : []);

  const teamLeaderId: string | undefined = typeof project?.teamLeaderId === 'string'
    ? project.teamLeaderId
    : undefined;

  // Project-specific tasks (public viewers may not have permission; we handle gracefully)
  const tasksQuery = useMemoFirebase(() => {
    if (!project?.id) return null;
    try {
      return query(collection(firestore, 'tasks'), where('projectId', '==', project.id));
    } catch {
      return null;
    }
  }, [firestore, project?.id]);
  const { data: projectTasks, loading: tasksLoading, error: tasksError } = useCollection(tasksQuery);

  // Progress derived from counters (preferred) or live tasks (fallback when permitted)
  const totalTasks = typeof project?.taskCount === 'number'
    ? project.taskCount
    : (projectTasks ? projectTasks.length : 0);
  const completedTasks = typeof project?.completedTaskCount === 'number'
    ? project.completedTaskCount
    : (projectTasks ? projectTasks.filter((t: any) => t.status === 'completed').length : 0);
  const percentComplete = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 100;

  if (loading) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 py-12 md:py-24">
          <div className="container mx-auto px-4 md:px-6">
            <div className="grid md:grid-cols-3 gap-8">
              <div className="md:col-span-2 space-y-8">
                <Skeleton className="h-12 w-3/4" />
                <Skeleton className="h-64 w-full rounded-xl" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-5/6" />
              </div>
              <div className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 flex items-center justify-center">
          <h2 className="text-2xl font-bold">Project not found</h2>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 py-12 md:py-24">
        <div className="container mx-auto px-4 md:px-6 animate-in fade-in duration-500">

          {/* Centered Header Section: Title & Hero Media */}
          <div className="flex flex-col items-center justify-center space-y-8 mb-12">
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-center text-glow max-w-4xl">{project.title}</h1>

            {/* Hero Media (Image or Video) */}
            <div className="w-full max-w-5xl">
              {(() => {
                // Prefer `imageUrl`, then `image_url`, then first of `media[]`
                const imageSrc = (() => {
                  const cleanUrl = (val: string): string | undefined => {
                    const cleaned = val.trim().replace(/[`]/g, '').replace(/[)\s]+$/g, '');
                    try {
                      const u = new URL(cleaned);
                      return u.toString();
                    } catch {
                      return undefined;
                    }
                  };
                  const candidates = [
                    typeof project?.imageUrl === 'string' ? cleanUrl(project.imageUrl) : undefined,
                    typeof project?.image_url === 'string' ? cleanUrl(project.image_url) : undefined,
                    Array.isArray(project?.media) && project.media.length > 0 && typeof project.media[0] === 'string' ? cleanUrl(project.media[0] as string) : undefined,
                  ];
                  for (const u of candidates) {
                    if (typeof u === 'string' && u.trim().length > 0) {
                      return u;
                    }
                  }
                  return undefined;
                })();

                // If video exists, it takes precedence as hero or we can stack them. 
                // For now, let's keep the image as the primary hero if present.

                return imageSrc ? (
                  <div className="w-full aspect-video relative rounded-xl overflow-hidden shadow-2xl shadow-primary/20 border border-accent/10">
                    <Image
                      src={imageSrc}
                      alt={project.title}
                      fill
                      sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px"
                      className="object-cover"
                      priority
                    />
                  </div>
                ) : (
                  // Fallback or No Image
                  <div className="w-full aspect-video rounded-xl bg-card/50 border border-accent/20 flex items-center justify-center">
                    <span className="text-muted-foreground">No image provided</span>
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-8 lg:gap-12">
            <div className="md:col-span-2 space-y-8">
              {/* Description */}
              <div
                className="prose prose-invert max-w-none font-body text-lg text-muted-foreground leading-relaxed"
                dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
              />

              {/* Video Section (if separate from hero image) */}
              {project.video_url && (
                <div className="w-full aspect-video rounded-xl overflow-hidden shadow-lg border border-accent/20 bg-black mt-8">
                  <iframe
                    src={project.video_url.replace('watch?v=', 'embed/')}
                    className="w-full h-full"
                    title="Project Video"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                </div>
              )}
            </div>

            <div className="space-y-6">
              <Card className="bg-card/80 backdrop-blur-sm border-accent/20">
                <CardHeader className="flex flex-row items-center gap-4">
                  <Users className="h-6 w-6 text-accent" />
                  <CardTitle>Team Members</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Team Lead (if available) */}
                  {teamLeaderId && (
                    <div className="flex items-center gap-3">
                      <span className="text-xs px-2 py-1 rounded bg-primary/20 text-primary border border-primary/30">Team Lead</span>
                      <MemberAvatar memberId={teamLeaderId} />
                    </div>
                  )}
                  {/* Team Members */}
                  <div className="flex flex-wrap gap-2">
                    {teamMembers && teamMembers.map((memberId: string) => (
                      <MemberAvatar key={memberId} memberId={memberId} />
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card/80 backdrop-blur-sm border-accent/20">
                <CardHeader>
                  <CardTitle>Tags</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {project.tags.map((tag: string) => (
                    <Badge key={tag} variant="secondary" className="font-body text-sm">
                      {tag}
                    </Badge>
                  ))}
                </CardContent>
              </Card>

              {/* External Links */}
              {(cleanUrl(project?.github_repo) || cleanUrl(project?.docs_url)) && (
                <Card className="bg-card/80 backdrop-blur-sm border-accent/20">
                  <CardHeader>
                    <CardTitle>Links</CardTitle>
                    <CardDescription>Quick access to project resources</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {cleanUrl(project?.github_repo) && (
                      <a
                        href={cleanUrl(project.github_repo)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                      >
                        <Github className="h-4 w-4" />
                        <span>GitHub Repository</span>
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    {cleanUrl(project?.docs_url) && (
                      <a
                        href={cleanUrl(project.docs_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                      >
                        <BookOpen className="h-4 w-4" />
                        <span>Documentation</span>
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

          {/* Roadmap & Progress section: placed below the grid, where indicated */}
          <div className="mt-12">
            <Card className="bg-card/80 backdrop-blur-sm border-accent/20">
              <CardHeader>
                <CardTitle>Roadmap & Progress</CardTitle>
                <CardDescription>
                  Live progress updates from project tasks and counters
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Overall Progress</span>
                    <span className="text-xs text-muted-foreground">
                      {totalTasks > 0
                        ? `${completedTasks}/${totalTasks} (${percentComplete}%)`
                        : 'Completed'}
                    </span>
                  </div>
                  <Progress value={percentComplete} />
                </div>

                {/* Task breakdown */}
                {tasksLoading && (
                  <p className="text-sm text-muted-foreground">Loading roadmap details…</p>
                )}

                {!tasksLoading && tasksError && (
                  <div className="text-sm text-muted-foreground">
                    Detailed task roadmap is visible to members. Sign in to view task breakdown.
                  </div>
                )}

                {!tasksLoading && !tasksError && projectTasks && projectTasks.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    {(['completed', 'in-progress', 'pending', 'overdue'] as const).map((status) => {
                      const items = projectTasks.filter((t: any) => t.status === status);
                      return (
                        <div key={status} className="rounded-lg border border-accent/20 bg-card/60 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium capitalize">{status.replace('-', ' ')}</span>
                            <span className="text-xs text-muted-foreground">{items.length}</span>
                          </div>
                          <ul className="space-y-2">
                            {items.slice(0, 5).map((t: any) => (
                              <li key={t.id} className="text-xs text-muted-foreground truncate">• {t.title}</li>
                            ))}
                            {items.length > 5 && (
                              <li className="text-xs text-muted-foreground">+ {items.length - 5} more…</li>
                            )}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                )}

                {!tasksLoading && !tasksError && (!projectTasks || projectTasks.length === 0) && (
                  <div className="text-sm text-green-500 font-medium flex items-center gap-2">
                    <span>✓</span> Project is completed.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

export default function ProjectDetailPage() {
  return (
    <Suspense fallback={<div className="relative flex min-h-screen flex-col items-center justify-center"><StarryBackground /><p>Loading...</p></div>}>
      <ProjectDetailContent />
    </Suspense>
  );
}
