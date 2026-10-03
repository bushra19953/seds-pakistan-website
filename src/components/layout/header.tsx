"use client";

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { motion, useScroll, useMotionValueEvent } from 'framer-motion';
import { Menu, X, Trophy, Home, Info, Briefcase, BookOpen, Calendar, Clock, Wrench, Image as ImageIcon, Mic, Mail, Shield, User, Heart, ShieldAlert, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useUser } from '@/firebase';
import { hasSiteAdminAccess } from '@/lib/roles';
import { useAuthorization } from '@/hooks/use-authorization';
import OptimizedLogo from '@/components/ui/optimized-logo';
import { ThemeToggleButton } from '@/components/theme-toggle-button';
import NotificationCenter from '@/components/notifications/notification-center';

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
 * - Logo size increased for better brand presence.
 * - Navigation remains icon + label without emojis for a more professional look.
 */
export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { user, role, isLoading } = useUser();
  const loginHref = `/auth?redirect=${encodeURIComponent(pathname || '/')}`;

  // Auto-hide state managed via scroll direction
  const { scrollY } = useScroll();
  const lastY = useRef(0);
  const [hidden, setHidden] = useState(false);

  // Listen to scroll changes and toggle header visibility based on direction
  useMotionValueEvent(scrollY, 'change', (latest) => {
    const current = latest ?? 0;
    const prev = lastY.current;
    const delta = current - prev;
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
    { name: 'Donate', path: '/donate', icon: Heart },
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
          { name: 'Donate', path: '/donate', icon: Heart },
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
          { name: 'Warning Registry', path: '/warning-registry', icon: ShieldAlert },
        ],
      },
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

  // Warm common routes after idle to speed up first navigation
  useEffect(() => {
    const routesToPrefetch = ['/projects', '/blog', '/events'];
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

  return (
    <motion.header
      initial="visible"
      animate={hidden ? 'hidden' : 'visible'}
      variants={variants}
      transition={{ type: 'tween', ease: 'easeInOut', duration: 0.25 }}
      className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex items-center justify-between"
      style={{ willChange: 'transform', touchAction: 'manipulation' }}
    >
      <div className="container flex h-20 md:h-24 items-center justify-between px-4">
        {/* Group 1: Logo (Far Left) - Fixed width container */}
        <div className="flex items-center justify-start w-[160px] md:w-[200px] shrink-0">
          <Link href="/" prefetch className="flex items-center">
            <OptimizedLogo
              src="/assets/logo.png"
              webpSrc="/assets/logo.webp"
              avifSrc="/assets/logo.avif"
              alt="SEDS Logo"
              width={128}
              height={128}
              priority
              sizes="(max-width: 768px) 80px, 112px"
              className="h-20 w-20 md:h-28 md:w-28 object-contain"
            />
          </Link>
        </div>

        {/* Group 2: Navigation + Actions (Right) */}
        <div className="flex items-center gap-4">
          {/* Primary Navigation */}
          <nav className="hidden md:flex items-center px-4">
            <div className="flex items-center gap-2">
              {desktopNav.map((item) => {
                // Plain link item
                if ('path' in item) {
                  return (
                    <Link
                      key={item.path}
                      href={item.path}
                      prefetch
                      className={`flex items-center gap-1.5 px-2 lg:px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-muted ${isActive(item.path) ? 'text-primary bg-muted' : 'text-muted-foreground'
                        }`}
                      title={item.name}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className="hidden lg:inline whitespace-nowrap">{item.name}</span>
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
                        className={`flex items-center gap-1.5 px-2 lg:px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-muted ${groupActive ? 'text-primary bg-muted' : 'text-muted-foreground'
                          }`}
                        aria-haspopup="menu"
                        aria-expanded={false}
                        title={item.name}
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span className="hidden lg:inline whitespace-nowrap">{item.name}</span>
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content
                      className="min-w-[220px] p-1 bg-popover border rounded-md shadow-md"
                      sideOffset={8}
                      align="start"
                    >
                      {item.children.map((child) => (
                        <DropdownMenu.Item key={child.path} asChild>
                          <Link
                            href={child.path}
                            prefetch
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm transition-colors hover:bg-muted ${isActive(child.path) ? 'text-primary' : 'text-muted-foreground'
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
                <NotificationCenter />
                {showAdmin && (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/admin" prefetch className="flex items-center gap-2" title="Admin Panel">
                      <Shield className="h-4 w-4" />
                      <span className="hidden lg:inline">Admin</span>
                    </Link>
                  </Button>
                )}
                <Button asChild variant="outline" size="sm">
                  <Link href="/profile" prefetch className="flex items-center gap-2" title="Profile">
                    <User className="h-4 w-4" />
                    <span className="hidden lg:inline">Profile</span>
                  </Link>
                </Button>
                <ThemeToggleButton />
              </>
            ) : (
              <>
                <Button asChild variant="outline" size="sm">
                  <Link href={loginHref} prefetch>Login</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/auth" prefetch>Sign Up</Link>
                </Button>
                <ThemeToggleButton />
              </>
            )}
          </div>

          {/* Mobile theme toggle in main header (visible on mobile) */}
          {/**
           * Change 3: Theme toggle moved into main header; removed from mobile menu
           * - Ensures the light/dark mode toggle is always accessible on mobile and desktop.
           */}
          <div className="md:hidden">
            <ThemeToggleButton aria-label="Toggle theme" />
          </div>

          {/* Mobile menu button */}
          <Sheet open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden shrink-0 min-h-[44px] min-w-[44px]"
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
                          className="px-3 py-3 min-h-[44px] rounded-md text-sm font-medium bg-orange-500 hover:bg-orange-600 text-foreground transition-colors"
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
                        className={`px-3 py-3 min-h-[44px] rounded-md text-sm flex items-center gap-2 transition-colors hover:bg-muted ${isActive(item.path) ? 'text-primary bg-muted' : 'text-muted-foreground'
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
                          className={`px-3 py-3 min-h-[44px] rounded-md text-sm flex items-center gap-2 transition-colors hover:bg-muted ${isActive(child.path) ? 'text-primary bg-muted' : 'text-muted-foreground'
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
                        <Button asChild variant="outline" size="sm" className="justify-start min-h-[44px]">
                          <Link href={loginHref} onClick={() => setIsMenuOpen(false)}>Login</Link>
                        </Button>
                        <Button asChild variant="outline" size="sm" className="justify-start min-h-[44px]">
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

    </motion.header>
  );
}
