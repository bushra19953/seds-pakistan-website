'use client'

import { Button } from '@/components/ui/button';
import { ArrowRight, Github, Globe } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { useProjects } from '@/hooks/use-projects';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { renderMarkdownSafe } from '@/lib/markdown';
import { MediaEmbed } from '@/components/ui/media-embed';

export default function ProjectsSection() {
  const { projects, loading, error } = useProjects(3);

  return (
    <section
      id="projects"
      className="py-20 md:py-32 bg-transparent"
      aria-labelledby="projects-heading"
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-12 slide-in-left">
          <h2
            id="projects-heading"
            className="text-4xl md:text-5xl font-bold mb-4 text-glow"
          >
            Explore Our Projects
          </h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg text-justify">
            From CubeSats to high-power rocketry, discover the innovative projects our members are building.
          </p>
        </div>
        {loading && (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-12">
            {[...Array(3)].map((_, index) => (
              <Card key={index} className="animate-pulse">
                <CardHeader>
                  <div className="h-6 bg-gray-200 rounded w-3/4 mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                </CardHeader>
                <CardContent>
                  <div className="h-40 bg-gray-200 rounded mb-4"></div>
                  <div className="h-4 bg-gray-200 rounded mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-5/6"></div>
                </CardContent>
                <CardFooter className="flex justify-end space-x-2">
                  <div className="h-8 w-8 bg-gray-200 rounded-full"></div>
                  <div className="h-8 w-8 bg-gray-200 rounded-full"></div>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
        {
          error && (
            <div className="text-center mb-12">
              <p className="text-muted-foreground">Projects are currently unavailable. Please check back later.</p>
            </div>
          )
        }
        {
          !loading && !error && projects.length === 0 && (
            <div className="text-center mb-12">
              <p className="text-muted-foreground">No projects found yet. Check back soon!</p>
            </div>
          )
        }
        {
          !loading && !error && projects.length > 0 && (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 mb-12">
              {projects.map((project) => (
                <Card key={project.id} className="flex flex-col">
                  {project.image_url && (
                    <MediaEmbed
                      url={project.image_url}
                      alt={project.title}
                      aspectRatio="16/9"
                      fill
                      className="rounded-t-lg"
                    />
                  )}
                  <CardHeader>
                    <CardTitle>{project.title}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <div
                      className="text-muted-foreground text-sm line-clamp-3 text-justify"
                      dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(project.summary || '') }}
                    />
                  </CardContent>
                  <CardFooter className="flex justify-end space-x-2">
                    {project.github_url && (
                      <Button asChild variant="ghost" size="icon" aria-label="GitHub Repository">
                        <a href={project.github_url} target="_blank" rel="noopener noreferrer">
                          <Github className="h-5 w-5" />
                        </a>
                      </Button>
                    )}
                    {project.live_url && (
                      <Button asChild variant="ghost" size="icon" aria-label="Live Site">
                        <a href={project.live_url} target="_blank" rel="noopener noreferrer">
                          <Globe className="h-5 w-5" />
                        </a>
                      </Button>
                    )}
                    <Button asChild variant="ghost" size="icon" aria-label="View Project Details">
                      <Link href={`/projects/${project.slug}`}>
                        <ArrowRight className="h-5 w-5" />
                      </Link>
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )
        }
        <div className="flex justify-center">
          <Button
            asChild
            size="lg"
            className="font-accent tracking-widest uppercase text-base hover:text-glow transition-all pulse-glow"
            aria-label="View all projects"
          >
            <Link href="/projects">
              View All Projects <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div >
    </section >
  );
}
