"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Orbit, Rocket, Satellite, Wrench, BookOpen, Users } from 'lucide-react';

export default function AboutPageSection() {
  const astronauticsTopics = [
    {
      icon: Orbit,
      title: "Astrodynamics",
      description: "The science of orbital mechanics, governing the motion of rockets and spacecraft through gravitational fields.",
      details: "Astrodynamics is the core of space mission planning, determining trajectories, orbital maneuvers, and the energy requirements for space travel."
    },
    {
      icon: Rocket,
      title: "Propulsion",
      description: "The engineering of systems that generate thrust to move vehicles through the vacuum of space.",
      details: "From chemical rockets to emerging electric propulsion, understanding propulsion is key to efficient space travel and mission success."
    },
    {
      icon: Satellite,
      title: "Spacecraft Systems",
      description: "The integration of complex subsystems that enable spacecraft to function in the harsh environment of space.",
      details: "Power, thermal control, communications, and attitude control systems must work together to ensure mission success."
    },
    {
      icon: Wrench,
      title: "Mission Operations",
      description: "The planning, execution, and management of space missions from concept through completion.",
      details: "Mission operations encompass everything from flight dynamics to ground station operations and data analysis."
    }
  ];

  const sedsMission = [
    {
      icon: BookOpen,
      title: "Education",
      description: "Providing hands-on learning experiences in space science and technology to students across Pakistan."
    },
    {
      icon: Users,
      title: "Community",
      description: "Building a network of passionate individuals dedicated to advancing space exploration in Pakistan."
    }
  ];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="text-center mb-16 animate-in fade-in slide-in-from-bottom-12 duration-500">
        <h1 className="text-5xl md:text-7xl font-headline tracking-tighter text-glow mb-6">
          About Astronautics
        </h1>
        <p className="text-xl font-body max-w-3xl mx-auto text-foreground/90">
          The science and technology of space travel that transforms cosmic ambition into reality.
        </p>
      </div>

      <div className="mb-20">
        <div className="grid md:grid-cols-2 gap-8 mb-16">
          <Card className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 animate-in fade-in slide-in-from-left-12 duration-500">
            <CardHeader>
              <CardTitle className="text-3xl font-headline text-glow">What is Astronautics?</CardTitle>
            </CardHeader>
            <CardContent className="font-body text-foreground/90 text-lg space-y-4">
              <p>
                Astronautics is the science and technology of space travel. It encompasses all aspects of space exploration, 
                from the fundamental physics of orbital mechanics to the engineering of spacecraft systems.
              </p>
              <p>
                Unlike traditional aeronautics, which deals with flight within Earth&apos;s atmosphere, astronautics focuses on 
                vehicles and systems designed to operate in the vacuum of space, where different physical laws and engineering 
                challenges apply.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 animate-in fade-in slide-in-from-right-12 duration-500">
            <CardHeader>
              <CardTitle className="text-3xl font-headline text-glow">Our Mission at SEDS</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-body text-foreground/90 text-lg mb-6">
                At SEDS Pakistan, we&apos;re dedicated to fostering the next generation of space professionals through education and hands-on experience.
              </p>
              <div className="space-y-4">
                {sedsMission.map((mission, index) => (
                  <div key={index} className="flex items-start gap-4">
                    <div className="p-2 bg-primary/10 text-primary rounded-full mt-1">
                      <mission.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="font-headline text-lg font-bold text-foreground">{mission.title}</h3>
                      <p className="font-body text-foreground/90">{mission.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mb-16">
        <div className="text-center mb-12 animate-in fade-in slide-in-from-bottom-12 duration-500">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">Core Disciplines</h2>
          <p className="max-w-2xl mx-auto font-body text-lg text-foreground/90">
            The fundamental areas of knowledge that form the foundation of space exploration.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {astronauticsTopics.map((topic, index) => (
            <Card 
              key={topic.title} 
              className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 h-full animate-in fade-in zoom-in-95"
              style={{animationDelay: `${index * 100}ms`}}
            >
              <CardHeader>
                <div className="mb-4 p-3 bg-primary/10 text-primary rounded-full w-fit">
                  <topic.icon className="h-8 w-8" />
                </div>
                <CardTitle className="text-2xl font-headline">{topic.title}</CardTitle>
                <CardDescription className="font-body text-base">
                  {topic.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="font-body text-foreground/90">
                  {topic.details}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div className="text-center animate-in fade-in slide-in-from-bottom-12 duration-500">
        <Card className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 max-w-3xl mx-auto">
          <CardContent className="p-8">
            <h3 className="text-2xl font-headline mb-4 text-glow">Join Our Journey</h3>
            <p className="font-body text-foreground/90 text-lg mb-6">
              Explore these concepts and more through our workshops, projects, and collaborative learning experiences.
            </p>
            <p className="font-body text-foreground/90">
              At SEDS Pakistan, we believe that understanding astronautics is the first step toward contributing to humanity&apos;s 
              future among the stars.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
