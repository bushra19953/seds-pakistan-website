import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

export default function HeroSection() {
  return (
    <section
      id="home"
      className="relative flex min-h-[calc(100vh-5rem)] w-full items-center py-16"
      aria-labelledby="hero-heading"
    >
      <div className="container mx-auto flex w-full items-center justify-center px-4 text-center md:px-6">
        <div className="flex max-w-4xl flex-col items-center gap-6 bounce-in animation-delay-200">
          <div className="flex flex-col gap-4">
            <h1
              id="hero-heading"
              className="text-4xl sm:text-5xl md:text-7xl lg:text-9xl font-headline tracking-tighter text-glow"
            >
              SEDS Pakistan
            </h1>
            <p className="mx-auto max-w-2xl text-base sm:text-lg md:text-xl text-muted-foreground font-body text-center">
              Join Pakistan&apos;s student space community. Learn to build rovers, rockets, and CanSats alongside teammates. Applications close Saturday, October 17 at 11:59 PM PKT.
            </p>
          </div>
          <div className="flex w-full flex-col items-stretch sm:w-auto sm:flex-row gap-4">
            <Button
              asChild
              size="lg"
              className="font-accent tracking-widest uppercase text-base hover:text-glow transition-all pulse-glow"
              aria-label="Apply now for SEDS Pakistan"
            >
              <Link href="/join">
                Apply Now <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
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
