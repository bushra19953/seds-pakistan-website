import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function HeroSection() {
  return (
    <section 
      id="home" 
      className="relative h-[calc(100vh-5rem)] min-h-[600px] w-full"
      aria-labelledby="hero-heading"
    >
      <div className="container mx-auto flex h-full items-center justify-center text-center px-4 md:px-6">
        <div className="flex flex-col items-center gap-6 bounce-in animation-delay-200">
          <div className="flex flex-col gap-2">
            <h1 
              id="hero-heading"
              className="text-5xl md:text-7xl lg:text-9xl font-headline tracking-tighter text-glow"
            >
              SEDS Pakistan
            </h1>
            <p className="max-w-3xl text-lg md:text-xl text-muted-foreground font-body text-justify">
              Forging the future of space exploration. From historical trust to futuristic ambition, join us on our cosmic journey.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-4">
            <Button 
              asChild 
              size="lg" 
              className="font-accent tracking-widest uppercase text-base hover:text-glow transition-all pulse-glow"
              aria-label="Join our mission"
            >
              <Link href="#join">
                Join The Mission <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
              </Link>
            </Button>
            <Button 
              asChild 
              size="lg" 
              variant="outline" 
              className="font-accent tracking-widest uppercase text-base hover:border-primary hover:text-primary transition-all pulse-glow"
              aria-label="View our projects"
            >
              <Link href="#projects">
                View Projects
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
