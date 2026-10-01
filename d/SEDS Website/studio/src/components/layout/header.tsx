"use client";

import Link from 'next/link';
import { useState } from 'react';
import { Menu, X, Shield, User } from 'lucide-react';
// ... existing code
import OptimizedLogo from '@/components/ui/optimized-logo';
import { Button } from '@/components/ui/button';
import { hasSiteAdminAccess } from '@/lib/roles';

export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
// ... existing code
  const showAdmin = !isLoading && user && role && hasSiteAdminAccess(role);

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-20 items-center justify-between px-4">
        {/* Group 1: Logo (Far Left) */}
        <div className="flex items-center justify-start">
          <Link href="/" className="flex items-center shrink-0">
            <OptimizedLogo
              src="/assets/logo.png"
              webpSrc="/assets/logo.webp"
              avifSrc="/assets/logo.avif"
              alt="SEDS Logo"
              width={48}
              height={48}
              className="h-12 w-12 object-contain"
            />
          </Link>
        </div>

        {/* Group 2: Primary Navigation (Center) */}
        <nav className="hidden md:flex items-center justify-center gap-1">
          {navItems.map((item) => (
            <Link
              key={item.path}
              href={item.path}
              className={`flex items-center gap-1.5 px-2 lg:px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-muted ${
                isActive(item.path) ? 'text-primary bg-muted' : 'text-muted-foreground'
              }`}
              title={item.name}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="hidden lg:inline whitespace-nowrap">{item.name}</span>
            </Link>
          ))}
        </nav>

        {/* Group 3: User Actions (Far Right) */}
        <div className="flex items-center justify-end gap-2">
          <div className="hidden md:flex items-center gap-2 shrink-0">
            {!isLoading && (
              <>
                {user ? (
                  <>
                    {showAdmin && (
                      <Button asChild variant="ghost" size="sm">
                        <Link href="/admin" className="flex items-center gap-2" title="Admin Panel">
                          <Shield className="h-4 w-4" />
                          <span className="hidden lg:inline">Admin</span>
                        </Link>
                      </Button>
                    )}
                    <Button asChild variant="default" size="sm">
                      <Link href="/profile" className="flex items-center gap-2" title="Profile">
                        <User className="h-4 w-4" />
                        <span className="hidden lg:inline">Profile</span>
                      </Link>
                    </Button>
                  </>
                ) : (
                  <>
                    <Button asChild variant="ghost" size="sm">
                      <Link href="/auth/login">Login</Link>
                    </Button>
                    <Button asChild variant="default" size="sm">
                      <Link href="/auth/signup">Sign Up</Link>
                    </Button>
                  </>
                )}
              </>
            )}
          </div>

          {/* Mobile menu button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden shrink-0"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            aria-label="Toggle menu"
          >
            {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {/* Mobile Navigation */}
      {isMenuOpen && (
        <div className="md:hidden border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container flex flex-col py-2">
            <div className="flex flex-col gap-1">
              {navItems.map((item) => (
                <Link
                  key={item.path}
                  href={item.path}
                  className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive(item.path) ? 'text-primary bg-muted' : 'text-muted-foreground hover:bg-muted'
                  }`}
                  title={item.name}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span>{item.name}</span>
                </Link>
              ))}
            </div>
            <div className="flex flex-col gap-1 pt-2">
              {!isLoading && (
                <>
                  {user ? (
                    <>
                      {showAdmin && (
                        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
                          <Link href="/admin" className="flex items-center gap-2" title="Admin Panel">
                            <Shield className="h-4 w-4" />
                            <span>Admin</span>
                          </Link>
                        </Button>
                      )}
                      <Button asChild variant="ghost" size="sm" className="w-full justify-start">
                        <Link href="/profile" className="flex items-center gap-2" title="Profile">
                          <User className="h-4 w-4" />
                          <span>Profile</span>
                        </Link>
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button asChild variant="ghost" size="sm" className="w-full justify-start">
                        <Link href="/auth/login">Login</Link>
                      </Button>
                      <Button asChild variant="default" size="sm" className="w-full justify-start">
                        <Link href="/auth/signup">Sign Up</Link>
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
