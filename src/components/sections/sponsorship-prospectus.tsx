"use client";

import { useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowRight, Calendar, Github, ExternalLink, Users, HandHeart, Filter } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { useProjectsByCategory } from '@/hooks/use-featured-projects';
import { formatDate } from '@/lib/utils';

const PROJECT_CATEGORIES = [
  { id: 'rocketry', name: 'Rocketry', description: 'High-power and experimental rocket systems' },
  { id: 'cubesat', name: 'CubeSat', description: 'Small satellite development and testing' },
  { id: 'rover', name: 'Rover', description: 'Autonomous and remote-controlled exploration vehicles' },
  { id: 'aerodynamics', name: 'Aerodynamics', description: 'Flight dynamics and propulsion research' },
];

export default function SponsorshipProspectus() {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const { projects: rocketryProjects, loading: rocketryLoading } = useProjectsByCategory('rocketry', 8);
  const { projects: cubesatProjects, loading: cubesatLoading } = useProjectsByCategory('cubesat', 8);
  const { projects: roverProjects, loading: roverLoading } = useProjectsByCategory('rover', 8);
  const { projects: aerodynamicsProjects, loading: aerodynamicsLoading } = useProjectsByCategory('aerodynamics', 8);

  const allProjects = useMemo(() => {
    return [
      ...rocketryProjects,
      ...cubesatProjects,
      ...roverProjects,
      ...aerodynamicsProjects,
    ];
  }, [rocketryProjects, cubesatProjects, roverProjects, aerodynamicsProjects]);

  const filteredProjects = useMemo(() => {
    if (selectedCategory === 'all') return allProjects;
    return allProjects.filter(project => project.category === selectedCategory);
  }, [allProjects, selectedCategory]);

  const hasSponsorshipContent = useMemo(() => {
    return allProjects.length > 0;
  }, [allProjects.length]);

  // Handle zero state: if no content is available, don't render the component
  if (!hasSponsorshipContent) {
    return null;
  }

  return (
    <section 
      id="sponsorship-prospectus" 
      className="py-20 md:py-32 bg-gradient-to-b from-primary/5 to-background"
      aria-labelledby="sponsorship-heading"
    >
      <div className="container mx-auto px-4 md:px-6">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 
            id="sponsorship-heading"
            className="text-4xl md:text-5xl font-bold mb-4 text-foreground"
          >
            Partnership Opportunities
          </h2>
          <p className="max-w-3xl mx-auto text-muted-foreground font-body text-lg">
            Invest in the future of space exploration. Partner with us to support groundbreaking student projects that drive innovation in aerospace engineering.
          </p>
        </div>

        {/* Tangible Outputs Gallery */}
        <div className="mb-16">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-2xl md:text-3xl font-bold mb-2">Tangible Outputs</h3>
              <p className="text-muted-foreground">
                See the concrete results of your investment in student innovation
              </p>
            </div>
            <div className="hidden md:flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Filter by category</span>
            </div>
          </div>

          {/* Category Filter */}
          <Tabs value={selectedCategory} onValueChange={setSelectedCategory} className="mb-8">
            <TabsList className="grid w-full grid-cols-2 md:grid-cols-5">
              <TabsTrigger value="all">All Projects</TabsTrigger>
              {PROJECT_CATEGORIES.map((category) => (
                <TabsTrigger key={category.id} value={category.id}>
                  {category.name}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="all" className="mt-8">
              <ProjectGallery projects={allProjects} loading={false} />
            </TabsContent>

            {PROJECT_CATEGORIES.map((category) => (
              <TabsContent key={category.id} value={category.id} className="mt-8">
                <ProjectGallery 
                  projects={allProjects.filter(p => p.category === category.id)} 
                  loading={false} 
                  categoryDescription={category.description}
                />
              </TabsContent>
            ))}
          </Tabs>
        </div>

        {/* Sponsorship Benefits */}
        <div className="bg-card/50 backdrop-blur-sm border border-border/50 rounded-2xl p-8 md:p-12 mb-16">
          <div className="text-center mb-8">
            <h3 className="text-2xl md:text-3xl font-bold mb-4">Why Partner With SEDS Pakistan?</h3>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Your sponsorship directly contributes to the development of the next generation of aerospace engineers and space innovators.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="text-center">
              <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <h4 className="font-semibold mb-2">Talent Pipeline</h4>
              <p className="text-sm text-muted-foreground">Access to skilled engineering students for internships and employment</p>
            </div>

            <div className="text-center">
              <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <HandHeart className="h-6 w-6 text-primary" />
              </div>
              <h4 className="font-semibold mb-2">Social Impact</h4>
              <p className="text-sm text-muted-foreground">Support STEM education and space exploration initiatives in Pakistan</p>
            </div>

            <div className="text-center">
              <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Calendar className="h-6 w-6 text-primary" />
              </div>
              <h4 className="font-semibold mb-2">Brand Visibility</h4>
              <p className="text-sm text-muted-foreground">Recognition at events, competitions, and in project documentation</p>
            </div>

            <div className="text-center">
              <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <ExternalLink className="h-6 w-6 text-primary" />
              </div>
              <h4 className="font-semibold mb-2">Innovation Access</h4>
              <p className="text-sm text-muted-foreground">Early access to cutting-edge research and prototype technologies</p>
            </div>
          </div>
        </div>

        {/* Call to Action */}
        <div className="text-center">
          <h3 className="text-2xl md:text-3xl font-bold mb-4">Ready to Make an Impact?</h3>
          <p className="text-muted-foreground max-w-2xl mx-auto mb-8">
            Join our network of visionary sponsors who are shaping the future of space exploration through student innovation.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button asChild size="lg" className="font-accent tracking-widest uppercase">
              <Link href="/contact">
                Become a Partner <HandHeart className="ml-2 h-5 w-5" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/projects">
                View All Projects <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </Button>
          </div>
        </div>

        {/* Admin Edit Link */}
        <div className="text-center mt-6">
          <a 
            href="/admin/projects"
            className="text-xs text-muted-foreground hover:text-primary underline underline-offset-4 transition-colors"
          >
            📝 Manage Featured Sponsorships
          </a>
        </div>
      </div>
    </section>
  );
}

interface ProjectGalleryProps {
  projects: any[];
  loading: boolean;
  categoryDescription?: string;
}

function ProjectGallery({ projects, loading, categoryDescription }: ProjectGalleryProps) {
  if (loading) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[...Array(6)].map((_, index) => (
          <Card key={index} className="animate-pulse">
            <CardHeader>
              <div className="h-6 bg-gray-200 rounded w-3/4 mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-1/2"></div>
            </CardHeader>
            <CardContent>
              <div className="h-32 bg-gray-200 rounded mb-4"></div>
              <div className="h-4 bg-gray-200 rounded w-full mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-2/3"></div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          {categoryDescription ? `No projects found in ${categoryDescription}.` : 'No projects found in this category.'}
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <Card 
          key={project.id} 
          className="bg-card/80 backdrop-blur-sm border-border/50 hover:border-primary/50 transition-all duration-300 group"
        >
          {project.featured_image_url && (
            <div className="relative w-full h-48 overflow-hidden rounded-t-lg">
              <Image
                src={project.featured_image_url}
                alt={project.title}
                fill
                className="object-cover group-hover:scale-105 transition-transform duration-300"
              />
            </div>
          )}
          
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="secondary" className="text-xs">
                {project.category || 'Project'}
              </Badge>
              {project.project_status && (
                <Badge 
                  variant={
                    project.project_status === 'Completed' ? 'default' :
                    project.project_status === 'In Progress' ? 'secondary' : 'outline'
                  }
                  className="text-xs"
                >
                  {project.project_status}
                </Badge>
              )}
            </div>
            
            <CardTitle className="text-lg line-clamp-2 group-hover:text-primary transition-colors">
              {project.title}
            </CardTitle>
            
            {project.summary && (
              <CardDescription className="line-clamp-3">
                {project.summary}
              </CardDescription>
            )}
          </CardHeader>
          
          <CardContent className="pt-0">
            {/* Sponsors */}
            {project.sponsors && project.sponsors.length > 0 && (
              <div className="flex items-center gap-1 mb-4">
                <HandHeart className="h-3 w-3 text-primary" />
                <span className="text-xs text-primary font-medium">
                  Sponsored by {project.sponsors.map((s: any) => s.name).join(', ')}
                </span>
              </div>
            )}

            {/* Tech Stack */}
            {project.tech_stack && project.tech_stack.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-4">
                {project.tech_stack.slice(0, 3).map((tech: string) => (
                  <Badge key={tech} variant="outline" className="text-xs">
                    {tech}
                  </Badge>
                ))}
                {project.tech_stack.length > 3 && (
                  <Badge variant="outline" className="text-xs">
                    +{project.tech_stack.length - 3}
                  </Badge>
                )}
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                {project.github_url && (
                  <Button asChild variant="ghost" size="sm" aria-label="View on GitHub">
                    <a href={project.github_url} target="_blank" rel="noopener noreferrer">
                      <Github className="h-4 w-4" />
                    </a>
                  </Button>
                )}
                {project.live_url && (
                  <Button asChild variant="ghost" size="sm" aria-label="View live demo">
                    <a href={project.live_url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                )}
              </div>
              
              <Button asChild variant="ghost" size="sm">
                <Link href={`/projects/detail?slug=${project.slug || project.id}`}>
                  View Details <ArrowRight className="h-3 w-3 ml-1" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}