"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExternalLink, BookOpen, Globe, Users, Rocket, Satellite, Zap } from 'lucide-react';

export default function ResourcesPageSection() {
  const nasaResources = [
    {
      title: "NASA 3D Resources",
      description: "Download and interact with 3D models of spacecraft, rovers, and space stations.",
      link: "https://nasa3d.arc.nasa.gov/",
      icon: Satellite
    },
    {
      title: "NASA Technical Reports Server",
      description: "Access thousands of aerospace technical reports, conference papers, and journal articles.",
      link: "https://ntrs.nasa.gov/",
      icon: BookOpen
    },
    {
      title: "NASA Climate Data",
      description: "Explore Earth science data and climate resources from NASA's Earth Observing System.",
      link: "https://climate.nasa.gov/",
      icon: Globe
    }
  ];

  const awesomeAerospace = [
    {
      title: "Awesome Space",
      description: "A curated list of awesome space-related packages and resources.",
      link: "https://github.com/orbitalindex/awesome-space",
      icon: Rocket
    },
    {
      title: "Awesome Astronomy",
      description: "A curated list of amazingly awesome astronomy libraries, software and resources.",
      link: "https://github.com/mbostock/awesome-astronomy",
      icon: Globe
    },
    {
      title: "Awesome Aerospace",
      description: "A curated list of awesome aerospace engineering resources.",
      link: "https://github.com/poliastro/awesome-aerospace",
      icon: Zap
    }
  ];

  const partners = [
    {
      name: "NASA",
      logo: "/logos/nasa.svg",
      description: "National Aeronautics and Space Administration"
    },
    {
      name: "ESA",
      logo: "/logos/esa.svg",
      description: "European Space Agency"
    },
    {
      name: "SEDS Global",
      logo: "/logos/seds-global.svg",
      description: "Students for the Exploration and Development of Space"
    }
  ];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="text-center mb-16">
        <h1 className="text-5xl md:text-7xl font-headline tracking-tighter text-glow mb-6">
          Resources & Collaborations
        </h1>
        <p className="text-xl text-muted-foreground font-body max-w-3xl mx-auto">
          Access valuable space resources and explore our partnerships with leading organizations.
        </p>
      </div>

      {/* NASA Resources Section */}
      <section className="mb-20">
        <div className="text-center mb-12">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">NASA Resources</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
            Access cutting-edge resources from the world&apos;s leading space agency.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {nasaResources.map((resource, index) => (
            <Card 
              key={resource.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 h-full"
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <resource.icon className="h-6 w-6" />
                </div>
                <CardTitle className="text-2xl font-headline">{resource.title}</CardTitle>
                <CardDescription className="font-body text-base">
                  {resource.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="w-full font-accent tracking-widest uppercase text-base hover:border-primary hover:text-primary transition-all" asChild>
                  <a href={resource.link} target="_blank" rel="noopener noreferrer">
                    Access Resource <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Awesome Resources Section */}
      <section className="mb-20">
        <div className="text-center mb-12">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">Awesome Aerospace GitHub Repos</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
            Curated lists of the best open-source resources in aerospace and astronomy.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {awesomeAerospace.map((resource, index) => (
            <Card 
              key={resource.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 h-full"
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <resource.icon className="h-6 w-6" />
                </div>
                <CardTitle className="text-2xl font-headline">{resource.title}</CardTitle>
                <CardDescription className="font-body text-base">
                  {resource.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="w-full font-accent tracking-widest uppercase text-base hover:border-primary hover:text-primary transition-all" asChild>
                  <a href={resource.link} target="_blank" rel="noopener noreferrer">
                    View on GitHub <ExternalLink className="ml-2 h-4 w-4" />
                  </a>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Partners Section */}
      <section className="mb-20">
        <div className="text-center mb-12">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">Our Partners</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
            Collaborating with leading organizations to advance space exploration in Pakistan.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {partners.map((partner, index) => (
            <Card 
              key={partner.name} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 text-center"
            >
              <CardHeader>
                <div className="mx-auto mb-4 bg-muted rounded-full w-24 h-24 flex items-center justify-center">
                  {partner.logo ? (
                    <img 
                      src={partner.logo} 
                      alt={partner.name} 
                      className="w-16 h-16 object-contain"
                    />
                  ) : (
                    <Users className="h-12 w-12 text-muted-foreground" />
                  )}
                </div>
                <CardTitle className="text-2xl font-headline">{partner.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="font-body text-muted-foreground">
                  {partner.description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}