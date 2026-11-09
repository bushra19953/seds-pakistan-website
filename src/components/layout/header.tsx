"use client";

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import React, { useEffect, useRef, useState } from 'react';
import { motion, useScroll, useMotionValueEvent, useReducedMotion } from 'framer-motion';
import { Menu, X, Trophy, Home, Info, Briefcase, BookOpen, Calendar, Clock, Wrench, Image as ImageIcon, Mic, Mail, Shield, User, Heart, ShieldAlert, Cpu, Network, ShoppingBag, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useUser } from '@/firebase/auth/use-user';
import { useSiteSettings } from '@/hooks/use-site-settings';
import { hasSiteAdminAccess } from '@/lib/roles';
import { useAuthorization } from '@/hooks/use-authorization';
import OptimizedLogo from '@/components/ui/optimized-logo';
import { ThemeToggleButton } from '@/components/theme-toggle-button';
import dynamic from 'next/dynamic';

// NotificationCenter is loaded on demand and mounted only for signed-in
// users (wave-2 hydration deferral). It renders null while signed out
// (read-burn fix F7, below), so gating the mount on `user` changes nothing
// a signed-out visitor sees — but it keeps the component and its graph
// (firebase/messaging via lib/push-notifications, the announcements and
// supa-notifications clients) out of the eager header bundle that every
// public page hydrates.
const NotificationCenter = dynamic(
  () => import('@/components/notifications/notification-center'),
  { ssr: false, loading: () => null }
);

/**
 * Header (Site Navigation)
 *
 * A reusable, client-side navigation bar designed to sit at the top of every page.
 * It follows a three-part layout:
 *  - Left: Site logo linking to the homepage
 *  - Center: A set of icon+label navigation links defined by a simple configuration array
 *  - Right: User action buttons (Admin, Profile) shown when authenticated with sufficient role
 *
 * Nav link configuration:
 *  Each item includes a `name`, `path`, and an associated Lucide icon component.
 *  This structure keeps the JSX clean and makes adding/reordering links straightforward.
 *
 * Notes:
 *  - Active link highlighting is handled via `usePathname()`; you can disable or adjust
 *    this logic later if you prefer purely static styling.
 *  - For a purely static variant (e.g., step 1 of a staged rollout), you can swap
 *    `path` values to `"#"` and remove `usePathname`/`isActive` while keeping the same JSX.
 */
/**
 * Updated Header with Auto-Hide on Scroll
 *
 * - Implements an auto-hiding behavior: header slides up when scrolling down,
 *   and reappears when scrolling up. Achieved via `framer-motion` and
 *   `useScroll` with a small threshold to avoid jitter.
 * - Navigation remains icon + label without emojis for a more professional look.
 *
 * Design pass 2026-11-09 (impeccable): the flat full-width strip is gone.
 * The header is now a FLOATING HUD DOCK in the mission-control world of
 * DESIGN.md: inset from the viewport edges on the content grid, rounded
 * corners, deep-navy glass, a hairline instrument border and one soft
 * offset shadow. Coral (the `primary` token) is the only signal colour:
 * the active route carries a segmented coral marker that slides between
 * routes, and Sign Up is the one coral action; Login stays a quiet ghost.
 * Nav labels are set in Orbitron (font-accent), the HUD label voice.
 * Founder order 2026-11-09: Store sits with Contact at the action end of
 * the nav, and the wordmark renders ~1.5x larger than the interim pass.
 */
export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // Read-burn fix F7: the header mounts ONE NotificationCenter, in the
  // always-visible row below. It used to mount two (desktop actions row,
  // mobile row) and gate fetching by breakpoint; CSS does not unmount,
  // and useIsMobile resolves after first paint (desktop-first), so a
  // mobile load ran the desktop instance's listener and announcement
  // fetch, then the mobile instance's, and every breakpoint crossing
  // re-paid both. One mount pays once, at every width.
  const pathname = usePathname();
  const router = useRouter();
  const { user, role, isLoading } = useUser();
  const { settings: siteSettings, loading: siteSettingsLoading } = useSiteSettings();
  const loginHref = `/auth?redirect=${encodeURIComponent(pathname || '/')}`;
  // Item 9: Donate nav entries follow the enableDonations flag. While
  // settings load, the entry is not rendered (no flash of a dead link).
  const showDonate = !siteSettingsLoading && siteSettings?.enableDonations === true;

  // Auto-hide state managed via scroll direction
  const { scrollY } = useScroll();
  const lastY = useRef(0);
  const [hidden, setHidden] = useState(false);
  // The dock condenses once the visitor is past the hero threshold, and
  // the active route carries a sliding coral marker. `scrolled` drives
  // the condensed height; the marker is a framer-motion layoutId element
  // in the nav below.
  const [scrolled, setScrolled] = useState(false);
  const reduceMotion = useReducedMotion();

  // Listen to scroll changes and toggle header visibility based on direction
  useMotionValueEvent(scrollY, 'change', (latest) => {
    const current = latest ?? 0;
    const prev = lastY.current;
    const delta = current - prev;
    setScrolled(current > 24);
    // Add small threshold to reduce jitter near top and small scrolls
    const threshold = 4;
    if (current <= 0) {
      setHidden(false);
    } else if (Math.abs(delta) > threshold) {
      setHidden(delta > 0); // scrolling down -> hide; up -> show
    }
    lastY.current = current;
  });

  // Centralized nav links configuration used by desktop and mobile menus below.
  const navItems = [
    { name: 'Home', path: '/', icon: Home },
    { name: 'Sourcing Bridge', path: '/sourcing-bridge', icon: Cpu },
    { name: 'About', path: '/about', icon: Info },
    { name: 'Projects', path: '/projects', icon: Briefcase },
    { name: 'Store', path: '/store', icon: ShoppingBag },
    ...(showDonate ? [{ name: 'Donate', path: '/donate', icon: Heart }] : []),
    { name: 'Blog', path: '/blog', icon: BookOpen },
    { name: 'Events', path: '/events', icon: Calendar },
    { name: 'Timeline', path: '/timeline', icon: Clock },
    { name: 'Skills', path: '/skills', icon: Wrench },
    { name: '3D Gallery', path: '/gallery', icon: ImageIcon },
    { name: 'Podcast', path: '/podcast', icon: Mic },
    { name: 'Community', path: '/community', icon: Trophy },
    { name: 'Contact', path: '/contact', icon: Mail },
  ];

  // Desktop navigation with dropdown groups to reduce top-level items.
  // Founder order 2026-11-09: Store leaves the front group and sits with
  // Contact at the action end (Store immediately before Contact). The
  // mobile sheet renders from this same configuration, so the order
  // carries over there too.
  const desktopNav: (
    | { name: string; path: string; icon: any }
    | { name: string; icon: any; children: { name: string; path: string; icon: any }[] }
  )[] = [
      { name: 'Home', path: '/', icon: Home },
      { name: 'Sourcing Bridge', path: '/sourcing-bridge', icon: Cpu },
      { name: 'Projects', path: '/projects', icon: Briefcase },
      {
        name: 'Explore',
        icon: Info,
        children: [
          { name: 'About', path: '/about', icon: Info },
          { name: 'Events', path: '/events', icon: Calendar },
          ...(showDonate ? [{ name: 'Donate', path: '/donate', icon: Heart }] : []),
          { name: 'Timeline', path: '/timeline', icon: Clock },
          { name: '3D Gallery', path: '/gallery', icon: ImageIcon },
        ],
      },
      {
        name: 'Learn',
        icon: BookOpen,
        children: [
          { name: 'Blog', path: '/blog', icon: BookOpen },
          { name: 'Podcast', path: '/podcast', icon: Mic },
          { name: 'Skills', path: '/skills', icon: Wrench },
        ],
      },
      {
        name: 'Community',
        icon: Trophy,
        children: [
          { name: 'Community Hub', path: '/community', icon: Trophy },
          { name: 'Hierarchy', path: '/hierarchy', icon: Network },
          { name: 'Warning Registry', path: '/warning-registry', icon: ShieldAlert },
        ],
      },
      { name: 'Store', path: '/store', icon: ShoppingBag },
      { name: 'Contact', path: '/contact', icon: Mail },
    ];

  const isActive = (path: string) => pathname === path;

  // Show Admin for hardcoded leadership roles OR dynamic roles with canAccessAdmin
  const { isAuthorized: canAccessAdmin } = useAuthorization('canAccessAdmin');
  const showAdmin = !isLoading && user && role && (hasSiteAdminAccess(role) || canAccessAdmin);

  const isGroupActive = (children: { path: string }[]) => children.some((c) => isActive(c.path));

  // Motion variants for smooth slide in/out
  const variants = {
    visible: { y: 0 },
    hidden: { y: '-100%' },
  };

  // Sliding active-route marker. Under reduced motion the marker snaps
  // instead of gliding.
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 480, damping: 38, mass: 0.7 };

  // Warm common routes after idle to speed up first navigation
  useEffect(() => {
    const routesToPrefetch = ['/projects', '/store', '/blog', '/events'];
    const prefetchAll = () => {
      try {
        routesToPrefetch.forEach((p) => router.prefetch(p));
      } catch { }
    };
    if ('requestIdleCallback' in window) {
      (window as any).requestIdleCallback(prefetchAll, { timeout: 1500 });
    } else {
      const t = setTimeout(prefetchAll, 1200);
      return () => clearTimeout(t);
    }
  }, [router]);

  // Shared nav treatments. Labels ride in Orbitron, the HUD label voice,
  // set as text-only instrument readouts (no per-item icons at the top
  // level: Orbitron is a wide face, and icon+label at this count would
  // crowd out the actions cell). Labels appear from xl up; below that
  // the nav cell is hidden and the mobile sheet carries the full menu.
  const navLinkClass = (active: boolean) =>
    `relative flex items-center gap-1.5 px-2.5 py-2 rounded-md font-accent text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${active ? 'text-primary' : 'text-muted-foreground'
    }`;
  const navMarker = (
    <motion.span
      layoutId="header-nav-marker"
      transition={pillTransition}
      className="absolute inset-x-3 bottom-[3px] h-[2px] rounded-full bg-primary"
      aria-hidden="true"
    />
  );

  return (
    <motion.header
      initial="visible"
      animate={hidden ? 'hidden' : 'visible'}
      variants={variants}
      transition={{ type: 'tween', ease: 'easeInOut', duration: 0.25 }}
      className="sticky top-0 z-50 w-full"
      style={{ willChange: 'transform', touchAction: 'manipulation' }}
    >
      {/* Floating dock gutter: the bar no longer spans the viewport. It
          sits inset on the same centred container as the page content
          (sections use `container mx-auto px-4 md:px-6`), with air above
          it; the sticky header keeps the gutter when stuck, so the dock
          floats at the top of the viewport while scrolling. */}
      <div className="px-3 pt-3 sm:px-4 md:px-6 md:pt-4">
        {/* The dock: deep-navy glass, hairline instrument border, one soft
            offset shadow. Three explicit columns keep the nav optically
            centred and pin logo/actions to the edges at every
            breakpoint, including mobile where the nav cell is hidden. */}
        <div
          className={`container mx-auto grid grid-cols-[1fr_auto_1fr] items-center rounded-2xl border border-border bg-background/80 px-4 shadow-[0_18px_38px_-14px_rgba(3,7,18,0.65)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/70 transition-[height] duration-300 motion-reduce:transition-none md:px-5 ${scrolled ? 'h-[4.75rem] md:h-24' : 'h-[5.25rem] md:h-28'
            }`}
        >
          {/* Group 1: Logo (Far Left). The wordmark artwork is mostly
              dark cosmos letters, so painted straight onto the navy
              dock it reads small and dim no matter how big its box is
              (the founder's "unreasonably small" complaint). It
              therefore sits on a light instrument plate — the
              documented foreground tone — so the full wordmark paints
              at full contrast and the lockup reads confidently.
              The header uses the TRIMMED asset (logo-header.*): the
              original 667x374 logo.png bakes in transparent padding
              (letters occupy only ~(153,136)-(514,239)), so even a big
              box showed small letters. The trimmed 387x127 (~3.05:1)
              crop is nearly all letters; the footer keeps the
              original asset untouched.
              Sizing must NOT rely on utilities on the <img>:
              OptimizedLogo hardcodes style width/height 'auto' inline,
              which outranks className utilities, so the img renders at
              its intrinsic size unless the caller overrides the style
              (later {...props} spread wins) inside a definite-width
              box — the same pattern the footer uses.
              Width-led box for the 3.05:1 trimmed wordmark: 128px/
              176px wide renders ~42px/~58px tall, condensed 112px/
              152px renders ~37px/~50px; the plate hugs that box with
              10px horizontal / 6px vertical padding, so the lockup
              lands at ~148x54 mobile and ~196x70 desktop. */}
          <div className="col-start-1 justify-self-start shrink-0">
            <Link
              href="/"
              prefetch
              className="flex items-center rounded-xl bg-[hsl(210_40%_96%)] px-2.5 py-1.5 shadow-[0_8px_20px_-8px_rgba(3,7,18,0.55)] ring-1 ring-[rgba(3,7,18,0.1)]"
            >
              <span
                className={`block transition-[width] duration-300 motion-reduce:transition-none ${scrolled ? 'w-[112px] md:w-[152px]' : 'w-[128px] md:w-[176px]'
                  }`}
              >
                <OptimizedLogo
                  src="/assets/logo-header.png"
                  webpSrc="/assets/logo-header.webp"
                  avifSrc="/assets/logo-header.avif"
                  alt="SEDS Logo"
                  width={387}
                  height={127}
                  priority
                  sizes="(max-width: 768px) 128px, 176px"
                  className="object-contain"
                  style={{ width: '100%', height: 'auto' }}
                />
              </span>
            </Link>
          </div>

          {/* Group 2: Primary Navigation (centre cell, optically centred
              between logo and actions). Dock nav is xl-up; below xl the
              hamburger sheet carries the full menu, because the Orbitron
              label set needs the full row width to breathe. */}
          <div className="col-start-2 hidden xl:flex justify-self-center">
            <nav className="flex items-center px-2">
              <div className="flex items-center gap-1">
                {desktopNav.map((item) => {
                  // Plain link item
                  if ('path' in item) {
                    const active = isActive(item.path);
                    return (
                      <Link
                        key={item.path}
                        href={item.path}
                        prefetch
                        className={navLinkClass(active)}
                        title={item.name}
                        aria-current={active ? 'page' : undefined}
                      >
                        <span className="relative z-10 hidden xl:inline whitespace-nowrap">{item.name}</span>
                        {active && navMarker}
                      </Link>
                    );
                  }

                  // Dropdown group item
                  const groupActive = isGroupActive(item.children);
                  return (
                    <DropdownMenu.Root key={item.name}>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          className={navLinkClass(groupActive)}
                          aria-haspopup="menu"
                          aria-expanded={false}
                          title={item.name}
                        >
                          <span className="relative z-10 hidden xl:inline whitespace-nowrap">{item.name}</span>
                          <ChevronDown className="relative z-10 hidden xl:block h-3 w-3 opacity-60" aria-hidden="true" />
                          {groupActive && navMarker}
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content
                        className="min-w-[220px] p-1.5 bg-popover/95 backdrop-blur-xl border border-border rounded-xl shadow-[0_18px_38px_-14px_rgba(3,7,18,0.65)]"
                        sideOffset={10}
                        align="start"
                      >
                        {item.children.map((child) => (
                          <DropdownMenu.Item key={child.path} asChild>
                            <Link
                              href={child.path}
                              prefetch
                              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg text-[13px] transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${isActive(child.path) ? 'text-primary' : 'text-muted-foreground'
                                }`}
                            >
                              <child.icon className="h-4 w-4 shrink-0" />
                              <span>{child.name}</span>
                            </Link>
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  );
                })}
              </div>
            </nav>
          </div>

          {/* Group 3: Actions (Right) */}
          <div className="col-start-3 flex items-center justify-self-end gap-4">
            {/* Notification bell: the single mounted instance (read-burn
                fix F7), visible at every breakpoint from this row. It
                renders null while signed out, so the logged-out header is
                unchanged — and it is now only mounted when signed in, so
                signed-out visitors never download it at all. */}
            {user ? <NotificationCenter /> : null}

            {/* User Actions */}
            <div className="hidden md:flex items-center gap-2">
              {/**
               * Authentication state rendering (robust and explicit):
               * - Loading: render nothing to avoid flicker/overlap
               * - Logged out: show Login and Sign Up
               * - Logged in: show Admin (if authorized) and Profile
               */}
              {isLoading ? null : user ? (
                <>
                  {showAdmin && (
                    <Button asChild variant="outline" size="sm" className="rounded-full h-8 px-3.5 text-[13px]">
                      <Link href="/admin" prefetch className="flex items-center gap-2" title="Admin Panel">
                        <Shield className="h-[15px] w-[15px]" />
                        <span className="hidden lg:inline">Admin</span>
                      </Link>
                    </Button>
                  )}
                  <Button asChild variant="outline" size="sm" className="rounded-full h-8 px-3.5 text-[13px]">
                    <Link href="/profile" prefetch className="flex items-center gap-2" title="Profile">
                      <User className="h-[15px] w-[15px]" />
                      <span className="hidden lg:inline">Profile</span>
                    </Link>
                  </Button>
                  <ThemeToggleButton />
                </>
              ) : (
                <>
                  <Button asChild variant="ghost" size="sm" className="rounded-full h-8 px-3.5 text-[13px] text-muted-foreground hover:text-foreground">
                    <Link href={loginHref} prefetch>Login</Link>
                  </Button>
                  <Button asChild size="sm" className="rounded-full h-8 px-4 text-[13px] font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_10px_24px_-10px_rgba(3,7,18,0.7)]">
                    <Link href="/auth" prefetch>Sign Up</Link>
                  </Button>
                  <ThemeToggleButton />
                </>
              )}
            </div>

            {/* Mobile theme toggle in main header (visible below xl,
                where the hamburger sheet carries navigation) */}
            {/**
             * Change 3: Theme toggle moved into main header; removed from mobile menu
             * - Ensures the light/dark mode toggle is always accessible on mobile and desktop.
             */}
            <div className="xl:hidden flex items-center gap-1">
              <ThemeToggleButton aria-label="Toggle theme" />
            </div>

            {/* Mobile menu button */}
            <Sheet open={isMenuOpen} onOpenChange={setIsMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="xl:hidden shrink-0 min-h-[44px] min-w-[44px]"
                  aria-label="Open menu"
                  aria-haspopup="dialog"
                  aria-expanded={isMenuOpen}
                  aria-controls="mobile-menu-sheet"
                  style={{ touchAction: 'manipulation' }}
                  onTouchStart={() => {
                    try {
                      // Provide subtle haptic feedback on supported devices
                      (navigator as any).vibrate?.(10);
                    } catch { }
                  }}
                >
                  {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                </Button>
              </SheetTrigger>
              {/**
               * Change 1: Mobile menu slides in from the right (was 'left')
               */}
              <SheetContent id="mobile-menu-sheet" side="right" className="w-[280px] bg-background/95 backdrop-blur overflow-y-auto z-[60]">
                <SheetHeader>
                  <SheetTitle>Menu</SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col py-4 gap-1">
                  {/* Map desktop groups into mobile sections */}
                  {desktopNav.map((item) => {
                    if ('path' in item) {
                      // Change 2: Restyle 'Contact' as a prominent CTA button in mobile menu
                      if (item.name === 'Contact') {
                        return (
                          <Button
                            key={item.path}
                            asChild
                            className="px-3 py-3 min-h-[44px] rounded-md text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground transition-colors"
                          >
                            <Link href={item.path} onClick={() => setIsMenuOpen(false)} className="flex items-center gap-2">
                              <Mail className="h-4 w-4" />
                              <span>Contact</span>
                            </Link>
                          </Button>
                        );
                      }
                      return (
                        <Link
                          key={item.path}
                          href={item.path}
                          className={`px-3 py-3 min-h-[44px] rounded-lg text-sm flex items-center gap-2 transition-colors hover:bg-foreground/5 hover:text-foreground ${isActive(item.path) ? 'text-primary bg-primary/10' : 'text-muted-foreground'
                            }`}
                          onClick={() => setIsMenuOpen(false)}
                        >
                          <item.icon className="h-4 w-4" />
                          <span>{item.name}</span>
                        </Link>
                      );
                    }

                    return (
                      <div key={item.name} className="flex flex-col gap-1">
                        <div className="px-3 pt-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          {item.name}
                        </div>
                        {item.children.map((child) => (
                          <Link
                            key={child.path}
                            href={child.path}
                            className={`px-3 py-3 min-h-[44px] rounded-lg text-sm flex items-center gap-2 transition-colors hover:bg-foreground/5 hover:text-foreground ${isActive(child.path) ? 'text-primary bg-primary/10' : 'text-muted-foreground'
                              }`}
                            onClick={() => setIsMenuOpen(false)}
                          >
                            <child.icon className="h-4 w-4" />
                            <span>{child.name}</span>
                          </Link>
                        ))}
                      </div>
                    );
                  })}

                  {/* Mobile User Actions: mirror desktop logic */}
                  {isLoading ? null : (
                    <div className="flex flex-col gap-2 px-3 pt-3 border-t mt-3">
                      {user ? (
                        <>
                          {showAdmin && (
                            <Button asChild variant="outline" size="sm" className="justify-start min-h-[44px]">
                              <Link href="/admin" className="flex items-center gap-2" onClick={() => setIsMenuOpen(false)}>
                                <Shield className="h-4 w-4" />
                                Admin Panel
                              </Link>
                            </Button>
                          )}
                          <Button asChild variant="outline" size="sm" className="justify-start min-h-[44px]">
                            <Link href="/profile" className="flex items-center gap-2" onClick={() => setIsMenuOpen(false)}>
                              <User className="h-4 w-4" />
                              Profile
                            </Link>
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button asChild variant="ghost" size="sm" className="justify-start min-h-[44px] text-muted-foreground">
                            <Link href={loginHref} onClick={() => setIsMenuOpen(false)}>Login</Link>
                          </Button>
                          <Button asChild size="sm" className="justify-start min-h-[44px] font-semibold bg-primary hover:bg-primary/90 text-primary-foreground">
                            <Link href="/auth" onClick={() => setIsMenuOpen(false)}>Sign Up</Link>
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </motion.header>
  );
}
