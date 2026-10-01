"use client";

import { useMemo, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuthorization } from '@/hooks/use-authorization';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MediaEmbed } from '@/components/ui/media-embed';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import {
  ArrowLeft,
  Calendar,
  Github,
  ExternalLink,
  Users,
  Wrench,
  Download,
  PlayCircle,
  ImageIcon,
  HandHeart,
  Clock,
  CheckCircle,
  Archive
} from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { useFirestore } from '@/firebase';
import { doc, getDoc } from 'firebase/firestore';
import type { EnhancedProject } from '@/types/enhanced-project';
import type { ProjectMember, Sponsor, MediaItem, Download as DownloadItem } from '@/types/enhanced-project';
import { formatDate } from '@/lib/utils';
import { useUser } from '@/firebase';

interface ProjectDetailPageProps {
  slug?: string;
}

export default function ProjectDetailPage({ slug }: ProjectDetailPageProps) {
  const searchParams = useSearchParams();
  const projectSlug = slug || searchParams?.get('slug');
  const firestore = useFirestore();
  const { user, role, allowedPaths } = useUser();
  const [project, setProject] = useState<EnhancedProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProject = async () => {
      if (!firestore || !projectSlug) return;

      try {
        setLoading(true);
        setError(null);

        // Try to find by slug first, then by ID
        let projectDoc = await getDoc(doc(firestore, 'projects', projectSlug));

        // If not found by slug, try searching by slug field (for projects that use custom slugs)
        if (!projectDoc.exists()) {
          // This is a simplified search - in production, you'd want a more robust search
          // For now, we'll just handle the basic case
          projectDoc = await getDoc(doc(firestore, 'projects', projectSlug));
        }

        if (projectDoc.exists()) {
          const data = projectDoc.data();
          const enhancedProject: EnhancedProject = {
            id: projectDoc.id,
            title: data.title,
            slug: data.slug || projectDoc.id,
            summary: data.summary || '',
            description: data.description || '',
            published: data.published ?? false,
            status: data.project_status || data.status,
            created_at: data.created_at?.toDate?.()?.toISOString() || new Date().toISOString(),
            updated_at: data.updated_at?.toDate?.()?.toISOString(),
            author_uid: data.author_uid,
            image_url: data.image_url,
            featured_image_url: data.featured_image_url,
            github_url: data.github_url,
            live_url: data.live_url,
            category: data.category,
            tags: data.tags || [],
            tech_stack: data.tech_stack || [],
            sponsors: data.sponsors || [],
            media_gallery: data.media_gallery || [],
            downloads: data.downloads || [],
            featured_on_recruitment_page: data.featured_on_recruitment_page || false,
            featured_on_sponsorship_page: data.featured_on_sponsorship_page || false,
            view_count: data.view_count || 0,
            started_at: data.started_at?.toDate?.(),
            completed_at: data.completed_at?.toDate?.(),
          };
          setProject(enhancedProject);
        } else {
          setError('Project not found');
        }

      } catch (err) {
        console.error('Error fetching project:', err);
        setError('Failed to load project details');
      } finally {
        setLoading(false);
      }
    };

    fetchProject();
  }, [firestore, projectSlug]);

  const { isAuthorized: isAdmin } = useAuthorization('canManageProjects');

  const statusIcon = useMemo(() => {
    switch (project?.project_status) {
      case 'Completed':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'In Progress':
        return <Clock className="h-4 w-4 text-blue-500" />;
      case 'Archived':
        return <Archive className="h-4 w-4 text-gray-500" />;
      default:
        return <Clock className="h-4 w-4 text-gray-500" />;
    }
  }, [project?.project_status]);

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen pt-20 pb-16">
        <div className="container mx-auto px-4 md:px-6">
          <div className="animate-pulse">
            <div className="h-8 bg-gray-200 rounded w-1/4 mb-8"></div>
            <div className="grid lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2">
                <div className="h-64 bg-gray-200 rounded mb-6"></div>
                <div className="h-8 bg-gray-200 rounded w-3/4 mb-4"></div>
                <div className="h-4 bg-gray-200 rounded w-1/2 mb-6"></div>
                <div className="space-y-3">
                  <div className="h-4 bg-gray-200 rounded"></div>
                  <div className="h-4 bg-gray-200 rounded"></div>
                  <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="h-32 bg-gray-200 rounded"></div>
                <div className="h-32 bg-gray-200 rounded"></div>
                <div className="h-32 bg-gray-200 rounded"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !project) {
    return (
      <div className="min-h-screen pt-20 pb-16">
        <div className="container mx-auto px-4 md:px-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold mb-4">Project Not Found</h1>
            <p className="text-muted-foreground mb-8">{error || 'The project you are looking for does not exist.'}</p>
            <Button asChild>
              <Link href="/projects">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Projects
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-20 pb-16">
      <div className="container mx-auto px-4 md:px-6">
        {/* Navigation */}
        <div className="mb-8">
          <Button asChild variant="ghost" className="mb-4">
            <Link href="/projects">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Projects
            </Link>
          </Button>
        </div>

        {/* Project Header */}
        <div className="grid lg:grid-cols-3 gap-8 mb-8">
          <div className="lg:col-span-2">
            {/* Featured Image */}
            {project.featured_image_url && (
              <MediaEmbed
                url={project.featured_image_url}
                alt={project.title}
                aspectRatio="16/9"
                fill
                priority
                className="mb-6 rounded-lg shadow-2xl"
              />
            )}

            {/* Project Title & Description */}
            <div className="mb-6">
              <div className="flex items-center gap-3 mb-4">
                <h1 className="text-3xl md:text-4xl font-bold">{project.title}</h1>
                {statusIcon}
                <span className="text-sm text-muted-foreground">{project.project_status || 'Unknown'}</span>
              </div>

              {project.summary && (
                <p className="text-lg text-muted-foreground mb-4">{project.summary}</p>
              )}

              {/* Badges */}
              <div className="flex flex-wrap gap-2 mb-4">
                {project.category && (
                  <Badge variant="secondary">{project.category}</Badge>
                )}
                {project.project_status && (
                  <Badge
                    variant={
                      project.project_status === 'Completed' ? 'default' :
                        project.project_status === 'In Progress' ? 'secondary' : 'outline'
                    }
                  >
                    {project.project_status}
                  </Badge>
                )}
                {project.featured_on_recruitment_page && (
                  <Badge variant="outline">Featured for Recruitment</Badge>
                )}
                {project.featured_on_sponsorship_page && (
                  <Badge variant="outline">Featured for Sponsorship</Badge>
                )}
              </div>

              {/* External Links */}
              <div className="flex gap-3">
                {project.github_url && (
                  <Button asChild variant="outline" size="sm">
                    <a href={project.github_url} target="_blank" rel="noopener noreferrer">
                      <Github className="h-4 w-4 mr-2" />
                      View Source
                    </a>
                  </Button>
                )}
                {project.live_url && (
                  <Button asChild variant="outline" size="sm">
                    <a href={project.live_url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Live Demo
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Project Info */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Project Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {project.created_at && (
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">
                      Started: {formatDate(new Date(project.created_at))}
                    </span>
                  </div>
                )}
                {project.completed_at && (
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">
                      Completed: {formatDate(project.completed_at)}
                    </span>
                  </div>
                )}
                {project.view_count !== undefined && (
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">
                      {project.view_count} views
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Team Members */}
            {project.team_members && project.team_members.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Users className="h-5 w-5" />
                    Team Members
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {project.team_members.map((member: ProjectMember) => (
                      <div key={member.id} className="flex items-center gap-3">
                        {member.avatar ? (
                          <div className="relative w-8 h-8">
                            <Image
                              src={member.avatar}
                              alt={member.name}
                              fill
                              className="rounded-full object-cover"
                            />
                          </div>
                        ) : (
                          <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center">
                            <Users className="h-4 w-4 text-primary" />
                          </div>
                        )}
                        <div>
                          <p className="text-sm font-medium">{member.name}</p>
                          <p className="text-xs text-muted-foreground">{member.role || 'Team Member'}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Sponsors */}
            {project.sponsors && project.sponsors.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <HandHeart className="h-5 w-5" />
                    Sponsors
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {project.sponsors.map((sponsor: Sponsor) => (
                      <div key={sponsor.id} className="flex items-center gap-3">
                        {sponsor.logo_url ? (
                          <div className="relative w-8 h-8">
                            <Image
                              src={sponsor.logo_url}
                              alt={sponsor.name}
                              fill
                              className="object-contain"
                            />
                          </div>
                        ) : (
                          <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center">
                            <HandHeart className="h-4 w-4 text-primary" />
                          </div>
                        )}
                        <div>
                          <p className="text-sm font-medium">{sponsor.name}</p>
                          {sponsor.website_url && (
                            <a
                              href={sponsor.website_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline"
                            >
                              Visit Website
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Tech Stack */}
            {project.tech_stack && project.tech_stack.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Wrench className="h-5 w-5" />
                    Technology Stack
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {project.tech_stack.map((tech: string) => (
                      <Badge key={tech} variant="outline" className="text-xs">
                        {tech}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Admin Edit Button */}
            {isAdmin && (
              <Card>
                <CardContent className="pt-6">
                  <Button asChild className="w-full">
                    <Link href={`/admin/projects/edit?id=${project.id}`}>
                      Edit Project
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Detailed Content */}
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="media">Media Gallery</TabsTrigger>
            <TabsTrigger value="downloads">Downloads</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-8">
            <Card>
              <CardHeader>
                <CardTitle>Project Description</CardTitle>
              </CardHeader>
              <CardContent>
                {project.description ? (
                  <div className="prose prose-sm max-w-none">
                    <p>{project.description}</p>
                  </div>
                ) : (
                  <p className="text-muted-foreground">No detailed description available.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="media" className="mt-8">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ImageIcon className="h-5 w-5" />
                  Media Gallery
                </CardTitle>
              </CardHeader>
              <CardContent>
                {project.media_gallery && project.media_gallery.length > 0 ? (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {project.media_gallery.map((media: MediaItem) => (
                      <div key={media.id} className="relative group">
                        <MediaEmbed
                          url={media.url}
                          alt={media.title || 'Project media'}
                          aspectRatio="16/9"
                          fill
                          className="group-hover:scale-105 transition-transform duration-300"
                        />
                        {media.title && (
                          <div className="mt-2">
                            <p className="text-sm font-medium">{media.title}</p>
                            {media.description && (
                              <p className="text-xs text-muted-foreground">{media.description}</p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">No media content available.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="downloads" className="mt-8">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Download className="h-5 w-5" />
                  Downloads
                </CardTitle>
              </CardHeader>
              <CardContent>
                {project.downloads && project.downloads.length > 0 ? (
                  <div className="space-y-3">
                    {project.downloads.map((download: DownloadItem) => (
                      <div key={download.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div>
                          <p className="font-medium">{download.title}</p>
                          {download.description && (
                            <p className="text-sm text-muted-foreground">{download.description}</p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {download.file_type.toUpperCase()} • Uploaded {formatDate(download.uploaded_at)}
                          </p>
                        </div>
                        <Button asChild variant="outline" size="sm">
                          <a href={download.file_url} target="_blank" rel="noopener noreferrer">
                            <Download className="h-4 w-4 mr-2" />
                            Download
                          </a>
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground">No downloads available.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="timeline" className="mt-8">
            <Card>
              <CardHeader>
                <CardTitle>Project Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {project.started_at && (
                    <div className="flex items-center gap-3">
                      <Calendar className="h-4 w-4 text-primary" />
                      <span className="text-sm">Project Started: {formatDate(project.started_at)}</span>
                    </div>
                  )}
                  {project.completed_at && (
                    <div className="flex items-center gap-3">
                      <CheckCircle className="h-4 w-4 text-green-500" />
                      <span className="text-sm">Project Completed: {formatDate(project.completed_at)}</span>
                    </div>
                  )}
                  {project.updated_at && (
                    <div className="flex items-center gap-3">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">Last Updated: {formatDate(new Date(project.updated_at))}</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}