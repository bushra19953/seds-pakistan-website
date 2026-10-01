"use client";

import { Newspaper, Rocket } from "lucide-react";

const newsItems = [
  { id: 1, text: "SEDS-ROCKETRY team announces successful test fire of their new hybrid engine." },
  { id: 2, text: "NASA confirms liquid water on Mars, opening new possibilities for future missions." },
  { id: 3, text: "SEDS Pakistan to host National Space Hackathon in collaboration with industry leaders." },
  { id: 4, text: "SpaceX successfully launches another batch of Starlink satellites." },
  { id: 5, text: "Our CubeSat team finalizes the design for the SEDS-SAT-1 mission." },
  { id: 6, text: "James Webb Telescope discovers most distant galaxy ever observed." },
];

export default function NewsSection() {
  // Duplicate the items to create a seamless loop
  const doubledNewsItems = [...newsItems, ...newsItems];

  return (
    <section id="news" className="py-8 bg-black/20 border-y-2 border-primary/50 backdrop-blur-sm">
      <div className="container mx-auto px-4 md:px-6">
        <div className="relative flex items-center overflow-hidden">
          <div className="flex-shrink-0 flex items-center gap-2 pr-4">
            <Newspaper className="h-6 w-6 text-primary" />
            <h2 className="font-accent text-lg font-bold tracking-wider text-primary uppercase">Latest News</h2>
          </div>
          <div className="flex-grow h-full relative overflow-hidden">
             <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-background/10 to-transparent pointer-events-none z-10" />
            <div className="flex whitespace-nowrap ticker-animation">
              {doubledNewsItems.map((item, index) => (
                <div key={index} className="flex items-center mx-6">
                  <span className="font-body text-muted-foreground">{item.text}</span>
                  <Rocket className="h-4 w-4 text-accent/50 ml-6" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
