import React from 'react';
import Link from 'next/link';
import { Twitter, Linkedin, Instagram } from 'lucide-react';
import OptimizedLogo from '@/components/ui/optimized-logo';
import { LEGAL_NAME } from '@/lib/legal-status';
import LegalIdentityBlock from '@/components/layout/legal-identity-block';

/**
 * Global Footer: the site's closing signature.
 *
 * Pattern: adapted from the 21st.dev "FirstReply Footer" (compact homepage
 * footer: brand block, tidy link columns, policy links, quiet bottom bar),
 * rebuilt natively in the site's deep navy + ivory world with a single gold
 * accent (#C9A45C). The component source on 21st.dev is account-gated, so
 * the pattern is followed structurally, not copied.
 *
 * - The footer always presents as a deep-navy panel, in both themes: the
 *   `dark` class scopes the dark design tokens to this subtree, so token
 *   colours inside (including the legal identity block) resolve dark.
 * - A gold hairline closes the page at the top edge; each column heading
 *   carries a short gold rule, echoing the Grand Prix hairlines.
 * - Every link, href, social URL and every word of legal/identity text is
 *   unchanged from the previous footer. Presentation only.
 */
export default function Footer() {
  const socialLinks = [
    { name: 'Twitter', icon: Twitter, href: 'https://twitter.com/sedspakistan' },
    { name: 'LinkedIn', icon: Linkedin, href: 'https://www.linkedin.com/company/seds-pakistan/' },
    { name: 'Instagram', icon: Instagram, href: 'https://instagram.com/sedspakistan' },
  ];

  const organisationLinks = [
    { label: 'Home', href: '/' },
    { label: 'Sourcing Bridge', href: '/sourcing-bridge' },
    { label: 'About', href: '/about' },
    { label: 'Projects', href: '/projects' },
    { label: 'Store', href: '/store' },
    { label: 'Contact', href: '/contact' },
  ];

  const resourcesLinks = [
    { label: 'Sourcing Bridge', href: '/sourcing-bridge' },
    { label: 'Blog', href: '/blog' },
    { label: 'Events', href: '/events' },
    { label: '3D Gallery', href: '/gallery' },
    { label: 'Podcast', href: '/podcast' },
    { label: 'Skills', href: '/skills' },
    { label: 'Privacy Policy', href: '/privacy-policy' },
    { label: 'Terms and Conditions', href: '/terms-and-conditions' },
    { label: 'Returns policy', href: '/store/returns' },
  ];

  const columnHeading = 'text-sm font-semibold text-[#F5F0E4]';
  const columnRule = 'mt-2.5 h-px w-6 bg-[#C9A45C]';
  const columnLink =
    'text-[#F5F0E4]/55 underline-offset-4 transition-colors hover:text-[#F5F0E4] hover:underline hover:decoration-[#C9A45C]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A45C]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0F1D]';

  return (
    <footer className="dark relative w-full bg-[#0A0F1D] text-[#F5F0E4]">
      {/* Gold hairline: the closing rule at the top edge */}
      <div
        aria-hidden="true"
        className="h-px bg-gradient-to-r from-transparent via-[#C9A45C]/80 to-transparent"
      />

      {/* Top: brand block + link columns */}
      <div className="container mx-auto px-4 py-14 md:px-6">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-4 xl:grid-cols-12">
          {/* Brand & Identity: spans 4 cols. The logo artwork already carries
              the SEDS wordmark, so no duplicate plain-text name beside it. */}
          <div className="col-span-2 md:col-span-1 xl:col-span-4">
            <div className="w-36 md:w-40">
              <OptimizedLogo
                src="/assets/logo.png"
                webpSrc="/assets/logo.webp"
                avifSrc="/assets/logo.avif"
                alt="SEDS Pakistan Logo"
                width={128}
                height={72}
                className="object-contain"
                style={{ width: '100%', height: 'auto' }}
              />
            </div>
            <div aria-hidden="true" className="mt-5 h-px w-10 bg-[#C9A45C]" />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-[#F5F0E4]/65">
              {LEGAL_NAME}
            </p>
          </div>

          {/* Organisation: spans 3 cols. Total left block = 7, aligns with User Directory. */}
          <div className="xl:col-span-3 lg:pl-4 xl:pl-8">
            <h3 className={columnHeading}>Organisation</h3>
            <div aria-hidden="true" className={columnRule} />
            <ul className="mt-4 space-y-2.5 text-sm">
              {organisationLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={columnLink}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources: spans 2 cols. Right block start, aligns with Role Dictionary. */}
          <div className="xl:col-span-2">
            <h3 className={columnHeading}>Resources</h3>
            <div aria-hidden="true" className={columnRule} />
            <ul className="mt-4 space-y-2.5 text-sm">
              {resourcesLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className={columnLink}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Follow Us: spans 3 cols. Total right block = 5. */}
          <div className="xl:col-span-3">
            <h3 className={columnHeading}>Follow Us</h3>
            <div aria-hidden="true" className={columnRule} />
            <div className="mt-4 flex items-center gap-3">
              {socialLinks.map((social) => (
                <Link
                  key={social.name}
                  href={social.href}
                  aria-label={social.name}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-[#F5F0E4]/15 text-[#F5F0E4]/70 transition-colors hover:border-[#C9A45C]/70 hover:text-[#C9A45C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A45C]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0F1D]"
                >
                  <social.icon className="h-[18px] w-[18px]" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom bar: copyright + legal identity, on a darker strip */}
      <div className="border-t border-[#F5F0E4]/10 bg-black/25">
        <div className="container mx-auto flex flex-col gap-3 px-4 py-6 md:flex-row md:items-start md:justify-between md:px-6">
          <p className="text-xs text-[#F5F0E4]/50 md:pt-0.5 md:text-sm">
            &copy; {new Date().getFullYear()} SEDS Pakistan All Rights Reserved
          </p>
          <LegalIdentityBlock className="max-w-xl md:text-right [&_p]:md:text-right" />
        </div>
      </div>
    </footer>
  );
}
