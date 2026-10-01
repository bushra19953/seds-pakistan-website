import Link from 'next/link';
import { Twitter, Linkedin, Instagram } from 'lucide-react';
import OptimizedLogo from '@/components/ui/optimized-logo';

/**
 * Professional Footer Redesign
 *
 * - Multi-column layout with clear grouping for navigation and social links.
 * - Brand column featuring the primary heading "SETS" and the logo.
 * - Copyright placed in a dedicated bottom bar with smaller, muted typography.
 */
export default function Footer() {
  const socialLinks = [
    { name: 'Twitter', icon: Twitter, href: 'https://twitter.com/sedspakistan' },
    { name: 'LinkedIn', icon: Linkedin, href: 'https://www.linkedin.com/company/seds-pakistan/' },
    { name: 'Instagram', icon: Instagram, href: 'https://instagram.com/sedspakistan' },
  ];

  const companyLinks = [
    { label: 'Home', href: '/' },
    { label: 'Sourcing Bridge', href: '/sourcing-bridge' },
    { label: 'About', href: '/about' },
    { label: 'Projects', href: '/projects' },
    { label: 'Contact', href: '/contact' },
  ];

  const resourcesLinks = [
    { label: 'Sourcing Bridge', href: '/sourcing-bridge' },
    { label: 'Blog', href: '/blog' },
    { label: 'Events', href: '/events' },
    { label: '3D Gallery', href: '/gallery' },
    { label: 'Podcast', href: '/podcast' },
    { label: 'Skills', href: '/skills' },
    { label: 'Warning Registry', href: '/warning-registry' },
  ];

  return (
    <footer className="relative w-full border-t border-border/20 bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/50">
      {/* Top: Multi-column layout */}
      <div className="container mx-auto py-12 px-4 md:px-6">
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-12 gap-8">
          {/* Brand & Identity: spans 4 cols */}
          <div className="xl:col-span-4">
            <div className="flex items-center gap-3">
              <OptimizedLogo
                src="/assets/logo.png"
                webpSrc="/assets/logo.webp"
                avifSrc="/assets/logo.avif"
                alt="SEDS Pakistan Logo"
                width={40}
                height={40}
                className="h-10 w-10 object-contain"
              />
              <span className="text-2xl md:text-3xl font-bold tracking-wider">SEDS</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Students for the Exploration and Development of Space — Pakistan Chapter.
            </p>
          </div>

          {/* Company: spans 3 cols. Total left block = 7, aligns with User Directory. */}
          <div className="xl:col-span-3 lg:pl-4 xl:pl-8">
            <h3 className="text-sm font-semibold text-foreground">Company</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {companyLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-foreground transition-colors">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources: spans 2 cols. Right block start, aligns with Role Dictionary. */}
          <div className="xl:col-span-2">
            <h3 className="text-sm font-semibold text-foreground">Resources</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {resourcesLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-foreground transition-colors">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Follow Us: spans 3 cols. Total right block = 5. */}
          <div className="xl:col-span-3">
            <h3 className="text-sm font-semibold text-foreground">Follow Us</h3>
            <div className="mt-3 flex items-center gap-3">
              {socialLinks.map((social) => (
                <Link
                  key={social.name}
                  href={social.href}
                  aria-label={social.name}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary transition-colors"
                >
                  <social.icon className="h-5 w-5" />
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom: Copyright */}
        <div className="mt-10 border-t border-border/20 pt-4">
          <p className="text-xs md:text-sm text-muted-foreground text-center">
            &copy; {new Date().getFullYear()} SEDS Pakistan All Rights Reserved
          </p>
        </div>
      </div>
    </footer>
  );
}
