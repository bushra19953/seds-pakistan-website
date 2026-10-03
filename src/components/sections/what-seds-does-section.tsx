"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  Rocket, 
  Satellite, 
  Users, 
  Code, 
  Cpu, 
  Zap,
  Wrench,
  BookOpen,
  Globe,
  Layers
} from 'lucide-react';
import SectionHeader from '@/components/sections/section-header';

export default function WhatSedsDoesSection() {
  const workshops = [
    {
      icon: Code,
      title: "Software Tools",
      description: "Master poliastro for orbital mechanics and GMAT for mission design.",
      details: "Learn industry-standard tools for space mission analysis and design."
    },
    {
      icon: Cpu,
      title: "Hardware Development",
      description: "Hands-on experience with OST (Open Source Rover) and other platforms.",
      details: "Build and program robotic systems that simulate space exploration tasks."
    }
  ];

  const groundStations = [
    {
      icon: Satellite,
      title: "SatNOGS Network",
      description: "Operating amateur ground stations for satellite tracking and data reception.",
      details: "Part of a global network of open-source ground stations for satellite operations."
    }
  ];

  const hackathons = [
    {
      icon: Users,
      title: "NASA Space Apps Challenge",
      description: "Annual global hackathon solving real-world problems using space data.",
      details: "Collaborate with teams worldwide to create innovative solutions."
    },
    {
      icon: Globe,
      title: "ActInSpace",
      description: "European space agency hackathon bringing space technology to Earth applications.",
      details: "Develop business solutions using space technologies and data."
    }
  ];

  const cubesat = [
    {
      icon: Layers,
      title: "AMSAT Projects",
      description: "Building and operating amateur radio satellites.",
      details: "Hands-on experience with satellite design, construction, and operation."
    },
    {
      icon: Code,
      title: "F Prime Framework",
      description: "Using NASA's F Prime flight software framework.",
      details: "Develop flight software for spacecraft and CubeSats."
    },
    {
      icon: Cpu,
      title: "Core Flight System (cFS)",
      description: "Implementing NASA's core Flight System architecture.",
      details: "Learn industry-standard flight software development practices."
    }
  ];

  const simulation = [
    {
      icon: Zap,
      title: "NASA 42 Dynamics",
      description: "Advanced spacecraft attitude and trajectory simulation.",
      details: "Professional-grade simulation for mission planning and analysis."
    },
    {
      icon: Globe,
      title: "Basilisk Simulator",
      description: "Modular simulation framework for spacecraft systems.",
      details: "Develop and test spacecraft control algorithms in a virtual environment."
    }
  ];

  const legacy = [
    {
      icon: Code,
      title: "Apollo 11 Code Restoration",
      description: "Contributing to the preservation of historic space software.",
      details: "Participate in open-source efforts to digitize and document Apollo mission code."
    }
  ];

  const openSource = [
    {
      icon: Globe,
      title: "Community Contributions",
      description: "Publishing tools, libraries, and educational resources.",
      details: "Sharing our work with the global space community to advance exploration."
    }
  ];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="text-center mb-16 animate-in fade-in slide-in-from-bottom-12 duration-500">
        <h1 className="text-5xl md:text-7xl font-headline tracking-tighter text-foreground mb-6">
          What SEDS Pakistan Does
        </h1>
        <p className="text-xl text-muted-foreground font-body max-w-3xl mx-auto">
          Empowering students through hands-on experience in space science and technology.
        </p>
      </div>

      {/* Workshops Section */}
      <section className="mb-20">
        <SectionHeader 
          title="Workshops & Training" 
          subtitle="Building technical skills through intensive hands-on learning experiences." 
        />
        <div className="grid md:grid-cols-2 gap-6">
          {workshops.map((workshop, index) => (
            <Card 
              key={workshop.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 animate-in fade-in zoom-in-95"
              style={{animationDelay: `${index * 100}ms`}}
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <workshop.icon className="h-6 w-6" />
                </div>
                <CardTitle className="text-2xl font-headline">{workshop.title}</CardTitle>
                <CardDescription className="font-body text-base text-justify">
                  {workshop.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="font-body text-muted-foreground text-justify">
                  {workshop.details}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Ground Stations Section */}
      <section className="mb-20">
        <SectionHeader 
          title="Ground Stations" 
          subtitle="Operating amateur radio infrastructure for satellite communications." 
        />
        <div className="grid md:grid-cols-2 gap-6">
          {groundStations.map((station, index) => (
            <Card 
              key={station.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 animate-in fade-in zoom-in-95"
              style={{animationDelay: `${index * 100}ms`}}
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <station.icon className="h-6 w-6" />
                </div>
                <CardTitle className="text-2xl font-headline">{station.title}</CardTitle>
                <CardDescription className="font-body text-base">
                  {station.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="font-body text-muted-foreground">
                  {station.details}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Hackathons Section */}
      <section className="mb-20">
        <SectionHeader 
          title="Hackathons & Competitions" 
          subtitle="Competing globally to solve real-world challenges with space technology." 
        />
        <div className="grid md:grid-cols-2 gap-6">
          {hackathons.map((hackathon, index) => (
            <Card 
              key={hackathon.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 animate-in fade-in zoom-in-95"
              style={{animationDelay: `${index * 100}ms`}}
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <hackathon.icon className="h-6 w-6" />
                </div>
                <CardTitle className="text-2xl font-headline">{hackathon.title}</CardTitle>
                <CardDescription className="font-body text-base">
                  {hackathon.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="font-body text-muted-foreground">
                  {hackathon.details}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* CubeSat Section */}
      <section className="mb-20">
        <SectionHeader 
          title="CubeSat Development" 
          subtitle="Designing, building, and operating nanosatellites for research and education." 
        />
        <div className="grid md:grid-cols-3 gap-6">
          {cubesat.map((project, index) => (
            <Card 
              key={project.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 animate-in fade-in zoom-in-95"
              style={{animationDelay: `${index * 100}ms`}}
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <project.icon className="h-6 w-6" />
                </div>
                <CardTitle className="text-2xl font-headline">{project.title}</CardTitle>
                <CardDescription className="font-body text-base text-justify">
                  {project.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="font-body text-muted-foreground text-justify">
                  {project.details}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Simulation Section */}
      <section className="mb-20">
        <SectionHeader 
          title="Simulation & Modeling" 
          subtitle="Using professional-grade tools for mission analysis and spacecraft design." 
        />
        <div className="grid md:grid-cols-2 gap-6">
          {simulation.map((tool, index) => (
            <Card 
              key={tool.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 animate-in fade-in zoom-in-95"
              style={{animationDelay: `${index * 100}ms`}}
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <tool.icon className="h-6 w-6" />
                </div>
                <CardTitle className="text-2xl font-headline">{tool.title}</CardTitle>
                <CardDescription className="font-body text-base">
                  {tool.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="font-body text-muted-foreground">
                  {tool.details}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Legacy Section */}
      <section className="mb-20">
        <SectionHeader 
          title="Legacy Code Preservation" 
          subtitle="Contributing to the preservation of historic space software." 
        />
        <div className="grid md:grid-cols-1 gap-6">
          {legacy.map((project, index) => (
            <Card 
              key={project.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 animate-in fade-in zoom-in-95"
              style={{animationDelay: `${index * 100}ms`}}
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <project.icon className="h-6 w-6" />
                </div>
                <CardTitle className="text-2xl font-headline">{project.title}</CardTitle>
                <CardDescription className="font-body text-base text-justify">
                  {project.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="font-body text-muted-foreground text-justify">
                  {project.details}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Open Source Section */}
      <section className="mb-20">
        <SectionHeader 
          title="Open Source Contributions" 
          subtitle="Sharing our work with the global space community." 
        />
        <div className="grid md:grid-cols-1 gap-6">
          {openSource.map((project, index) => (
            <Card 
              key={project.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 animate-in fade-in zoom-in-95"
              style={{animationDelay: `${index * 100}ms`}}
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <project.icon className="h-6 w-6" />
                </div>
                <CardTitle className="text-2xl font-headline">{project.title}</CardTitle>
                <CardDescription className="font-body text-base">
                  {project.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="font-body text-muted-foreground">
                  {project.details}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
