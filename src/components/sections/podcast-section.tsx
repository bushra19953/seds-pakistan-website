"use client";

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PlayCircle, Mic, Rss } from 'lucide-react';
import Image from 'next/image';

const podcastEpisodes = [
  {
    id: 1,
    title: "Ep. 1: The Future of Pakistani Space Exploration",
    description: "A conversation with leading engineers and scientists about Pakistan's role in the future of space.",
    imageUrl: "https://picsum.photos/seed/p1/600/400",
    imageHint: "galaxy nebula",
    duration: "45:12",
  },
  {
    id: 2,
    title: "Ep. 2: From CubeSats to Constellations",
    description: "Deep dive into small satellite technology and its potential for communication and research.",
    imageUrl: "https://picsum.photos/seed/p2/600/400",
    imageHint: "satellite earth",
    duration: "52:30",
  },
  {
    id: 3,
    title: "Ep. 3: A Talk with a NASA Astronaut",
    description: "We sit down with a special guest to discuss their journey to the International Space Station and beyond.",
    imageUrl: "https://picsum.photos/seed/p3/600/400",
    imageHint: "astronaut helmet",
    duration: "1:05:50",
  },
  {
    id: 4,
    title: "Ep. 4: The Physics of Interstellar Travel",
    description: "Exploring the theoretical physics behind wormholes, warp drives, and what it might take to reach the stars.",
    imageUrl: "https://picsum.photos/seed/p4/600/400",
    imageHint: "wormhole space",
    duration: "38:22",
  },
];


export default function PodcastSection() {
  return (
    <section id="podcast" className="py-20 md:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-16 animate-in fade-in slide-in-from-bottom-12 duration-500">
          <div className="mx-auto bg-primary/10 text-primary p-3 rounded-full w-fit mb-4">
              <Mic className="h-10 w-10"/>
          </div>
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">Cosmic Conversations</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
            Tune in to the official podcast of SEDS Pakistan. We explore the latest in space tech, interview industry experts, and discuss our journey to the stars.
          </p>
          <div className="flex justify-center gap-4 mt-6">
            <Button variant="outline" size="lg" className="font-accent tracking-widest uppercase">
              <Rss className="mr-2" /> Subscribe via RSS
            </Button>
          </div>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-1 gap-8">
          {podcastEpisodes.map((episode, index) => (
            <div key={episode.id} className="animate-in fade-in slide-in-from-bottom-12 duration-500" style={{ animationDelay: `${index * 150}ms` }}>
              <Card className="bg-card/80 backdrop-blur-sm border-accent/20 shadow-xl shadow-accent/5 overflow-hidden transition-all hover:border-primary/80 group">
                <div className="grid md:grid-cols-3">
                  <div className="md:col-span-1">
                     <Image
                        src={episode.imageUrl}
                        alt={episode.title}
                        width={600}
                        height={400}
                        className="w-full h-full object-cover"
                        data-ai-hint={episode.imageHint}
                      />
                  </div>
                  <div className="md:col-span-2">
                    <CardHeader>
                      <CardTitle className="text-2xl font-headline tracking-wide">{episode.title}</CardTitle>
                      <CardDescription className="font-body text-muted-foreground">{episode.description}</CardDescription>
                    </CardHeader>
                    <CardFooter>
                      <Button className="font-accent tracking-widest uppercase text-base hover:text-glow transition-all">
                        <PlayCircle className="mr-2"/>
                        Play ({episode.duration})
                      </Button>
                    </CardFooter>
                  </div>
                </div>
              </Card>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
