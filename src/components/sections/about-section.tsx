"use client";

import { useEffect, useState, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Orbit, Rocket, DraftingCompass, Server } from 'lucide-react';

const topics = [
  {
    icon: Orbit,
    title: "Astrodynamics",
    description: "The science of orbital mechanics, governing the motion of rockets and spacecraft."
  },
  {
    icon: Rocket,
    title: "Rocket Propulsion",
    description: "Mastering the principles of thrust and engine design that power launch vehicles."
  },
  {
    icon: DraftingCompass,
    title: "Spacecraft Design",
    description: "Engineering the complex systems of satellites, probes, and crewed vehicles."
  },
  {
    icon: Server,
    title: "Mission Operations",
    description: "Managing the lifecycle of a space mission, from launch to data telemetry."
  }
];

export default function AboutSection() {
  // Ensure model-viewer custom element is available on the client
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Check if already defined
    if (customElements.get('model-viewer')) {
      setScriptLoaded(true);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        const script = document.createElement('script');
        script.type = 'module';
        script.src = 'https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js';
        script.onload = () => setScriptLoaded(true);
        document.head.appendChild(script);
        observer.disconnect();
      }
    }, { rootMargin: '200px' }); // Start loading 200px before it comes into view

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, []);

  const ModelViewer = 'model-viewer' as any;

  return (
    <section id="about" ref={sectionRef} className="py-20 md:py-32 bg-transparent text-foreground">
      <div className="container mx-auto px-4 md:px-6">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div className="slide-in-left space-y-8">
            <div>
              <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">About Astronautics</h2>
              <p className="font-body text-lg leading-relaxed text-justify text-foreground/90">
                Astronautics is the science and technology of space travel. At SEDS, we delve into the core disciplines that turn cosmic ambition into reality, empowering the next generation of space engineers and scientists in Pakistan.
              </p>
            </div>
            <div className="space-y-6">
              {topics.map((topic) => (
                <div key={topic.title} className="flex items-start gap-4 group hover:scale-105 transition-transform duration-300">
                  <div className="p-2 bg-accent/10 text-accent rounded-full group-hover:bg-primary/10 group-hover:text-primary transition-colors duration-300">
                    <topic.icon className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="font-accent text-xl font-bold text-foreground group-hover:text-primary transition-colors duration-300">{topic.title}</h3>
                    <p className="font-body text-foreground/90 text-justify">{topic.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="slide-in-right">
            <Card className="bg-transparent border-accent/20 shadow-xl shadow-accent/5">
              <CardContent className="p-2">
                <div className="h-[400px] flex items-center justify-center bg-black/5 rounded-lg">
                  {scriptLoaded ? (
                    <ModelViewer
                      src="https://modelviewer.dev/shared-assets/models/Astronaut.glb"
                      alt="Interactive astronaut 3D model"
                      camera-controls
                      auto-rotate
                      ar
                      shadow-intensity="1"
                      exposure="0.9"
                      style={{ height: '100%', width: '100%' }}
                    />
                  ) : (
                    <div className="text-muted-foreground animate-pulse flex flex-col items-center">
                      <Rocket className="h-10 w-10 mb-2 opacity-50" />
                      <span>Loading 3D Model...</span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
}
