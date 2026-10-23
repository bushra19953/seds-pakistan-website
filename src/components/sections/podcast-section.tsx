import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Mic, Rocket, Satellite, Telescope, BookOpen, Calendar } from 'lucide-react';
import Link from 'next/link';

const plannedTopics = [
  {
    icon: Rocket,
    title: 'Student Rocketry',
    description:
      'How SEDS chapter teams design, build, and launch sounding rockets, and what flight day actually teaches you.',
  },
  {
    icon: Satellite,
    title: 'Small Satellites',
    description:
      'CubeSats and CanSats explained by the students building them, from first circuit board to a working payload.',
  },
  {
    icon: Telescope,
    title: 'Paths Into Space',
    description:
      'Honest conversations about studying and working in the space sector from Pakistan, and the routes people took to get there.',
  },
];

export default function PodcastSection() {
  return (
    <section id="podcast" className="py-20 md:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-16 animate-in fade-in slide-in-from-bottom-12 duration-500">
          <div className="mx-auto bg-primary/10 text-primary p-3 rounded-full w-fit mb-4">
            <Mic className="h-10 w-10" />
          </div>
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-foreground">Cosmic Conversations</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
            The official podcast of SEDS Pakistan is in production. Season one is being recorded now,
            and nothing has been released yet. When the first episode is ready, it will be published here.
          </p>
        </div>

        <div className="max-w-3xl mx-auto mb-16 animate-in fade-in slide-in-from-bottom-12 duration-500">
          <Card className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5">
            <CardHeader className="text-center">
              <CardTitle className="text-2xl font-headline tracking-wide">Season 1: In Production</CardTitle>
              <CardDescription className="font-body text-muted-foreground">
                We are a student society, and the show is being made the same way our rockets are:
                by members, between classes, with the equipment we have. Recording is under way.
                There are no episodes to play yet, and we would rather say that plainly than fill
                this page with placeholders.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <p className="font-body text-muted-foreground">
                Until the first episode lands, the society is publishing in two places that are live today.
              </p>
              <div className="flex flex-wrap justify-center gap-4 mt-6">
                <Button asChild size="lg" className="font-accent tracking-widest uppercase">
                  <Link href="/blog">
                    <BookOpen className="mr-2" /> Read the Blog
                  </Link>
                </Button>
                <Button asChild variant="outline" size="lg" className="font-accent tracking-widest uppercase">
                  <Link href="/events">
                    <Calendar className="mr-2" /> See Events
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="max-w-5xl mx-auto">
          <h3 className="text-center text-2xl md:text-3xl font-bold mb-4 text-foreground">On the Slate</h3>
          <p className="text-center max-w-2xl mx-auto text-muted-foreground font-body mb-10">
            The subjects season one is being built around. These are the conversations we are
            recording, not episodes you can play today.
          </p>
          <div className="grid md:grid-cols-3 gap-8">
            {plannedTopics.map((topic, index) => (
              <div
                key={topic.title}
                className="animate-in fade-in slide-in-from-bottom-12 duration-500"
                style={{ animationDelay: `${index * 150}ms` }}
              >
                <Card className="h-full bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 transition-all hover:border-primary/80">
                  <CardHeader>
                    <div className="bg-primary/10 text-primary p-3 rounded-full w-fit mb-2">
                      <topic.icon className="h-6 w-6" />
                    </div>
                    <CardTitle className="text-xl font-headline tracking-wide">{topic.title}</CardTitle>
                    <CardDescription className="font-body text-muted-foreground">{topic.description}</CardDescription>
                  </CardHeader>
                </Card>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
