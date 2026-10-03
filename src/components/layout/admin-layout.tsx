'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useUser } from '@/firebase/auth/use-user';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Menu } from 'lucide-react';
import {
  AlertTriangle,
  Award,
  BarChart2,
  BookOpen,
  Briefcase,
  Bug,
  Building2,
  Calendar,
  CheckCircle,
  Clock,
  Coins,
  Compass,
  Crown,
  Database,
  FileLock,
  FileSpreadsheet,
  FileText,
  FolderKanban,
  GitMerge,
  IdCard,
  Image as ImageIcon,
  Inbox,
  LayoutDashboard,
  Mail,
  Megaphone,
  Network,
  Newspaper,
  Phone,
  Rocket,
  Settings,
  Shield,
  ShoppingCart,
  Sparkles,
  Target,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';

// Static icon map for admin nav items. The nav config stores icon names as
// strings, so we resolve them through this map instead of `import * as Icons`,
// which pulled the entire lucide-react barrel (5k+ modules) into the bundle.
const ADMIN_NAV_ICONS: Record<string, LucideIcon> = {
  AlertTriangle,
  Award,
  BarChart2,
  BookOpen,
  Briefcase,
  Bug,
  Building2,
  Calendar,
  CheckCircle,
  Clock,
  Coins,
  Compass,
  Crown,
  Database,
  FileLock,
  FileSpreadsheet,
  FileText,
  FolderKanban,
  GitMerge,
  IdCard,
  Image: ImageIcon,
  Inbox,
  LayoutDashboard,
  Mail,
  Megaphone,
  Network,
  Newspaper,
  Phone,
  Rocket,
  Settings,
  Shield,
  ShoppingCart,
  Sparkles,
  Target,
  UserPlus,
  Users,
};
import StarryBackground from '@/components/starry-background';
import { USER_ROLES, hasSufficientRole, UserRole } from '@/lib/roles';
import OptimizedLogo from '@/components/ui/optimized-logo';
import { adminNav } from '@/config/admin-nav';

interface AdminLayoutProps {
  children: React.ReactNode;
  title: string;
  description: string;
}

export default function AdminLayout({ children, title, description }: AdminLayoutProps) {
  const { user, role, isLoading } = useUser();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  useEffect(() => {
    if (isLoading) return;

    if (!user) {
      router.replace('/auth/login');
      return;
    }

    if (role && !hasSufficientRole(role, 'member')) {
      router.replace('/auth/login');
      return;
    }
  }, [user, role, router]);

  if (!user || !role || !hasSufficientRole(role, 'member')) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-gray-800 mb-2">Access Denied</h2>
          <p className="text-gray-600">You don&apos;t have permission to access the admin panel.</p>
          <button 
            onClick={() => router.replace('/auth/login')}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  const flatNav = adminNav.flatMap((group) => group.items).filter((item) => !item.minRole || (role && hasSufficientRole(role, item.minRole as UserRole)));

  return (
    <div className="relative flex min-h-screen flex-col bg-background text-foreground">
      <StarryBackground />
      {/* Top Bar */}
      <header className="sticky top-0 z-40 w-full border-b border-primary/20 bg-background/80 backdrop-blur-md">
        <div className="container flex h-16 items-center justify-between py-4">
          <div className="flex items-center space-x-4">
            <Link href="/" className="flex items-center space-x-2">
              <OptimizedLogo
              src="/assets/logo.png"
              webpSrc="/assets/logo.webp"
              avifSrc="/assets/logo.avif"
              alt="SEDS Pakistan Logo"
              width={32}
              height={32}
              className="mr-2"
            />
              {/* <span className="hidden font-bold sm:inline-block">SEDS Pakistan Admin</span> */}
            </Link>
            {role && (
              <span className="ml-4 rounded-full bg-primary/20 px-3 py-1 text-sm font-medium text-primary-foreground">
                {USER_ROLES[role as keyof typeof USER_ROLES]}
              </span>
            )}
          </div>
          <div className="flex items-center space-x-4">
            {/* Mobile Sidebar Toggle */}
            <Sheet open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
              <SheetTrigger asChild className="lg:hidden">
                <Button variant="ghost" size="icon" aria-label="Open navigation">
                  <Menu className="h-6 w-6" aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[250px] bg-background/90 backdrop-blur-md">
                <SheetHeader>
                  <SheetTitle>Navigation</SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col space-y-2 py-4">
                  {flatNav.map((item) => {
                    const Icon = item.icon ? ADMIN_NAV_ICONS[item.icon] ?? null : null;
                    return (
                      <Link
                        key={item.path}
                        href={item.path}
                        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-primary/10"
                        onClick={() => setIsSidebarOpen(false)}
                      >
                        {Icon ? <Icon className="h-4 w-4" /> : null}
                        {item.label}
                      </Link>
                    );
                  })}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Desktop Sidebar */}
        <aside className="hidden w-64 flex-col border-r border-primary/20 bg-background/80 backdrop-blur-md p-4 lg:flex relative">
          <div className="absolute inset-0 opacity-10">
            <OptimizedLogo
              src="/assets/logo.png"
              webpSrc="/assets/logo.webp"
              avifSrc="/assets/logo.avif"
              alt="SEDS Pakistan Logo Watermark"
              width={200}
              height={200}
              className="pointer-events-none object-contain"
            />
          </div>
          <nav className="relative z-10 flex flex-col space-y-2">
            {flatNav.map((item) => {
              const Icon = item.icon ? ADMIN_NAV_ICONS[item.icon] ?? null : null;
              return (
              <Link
                key={item.path}
                href={item.path}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-primary/10"
              >
                {Icon ? <Icon className="h-4 w-4" /> : null}
                {item.label}
              </Link>
            );})}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-8">
          <div className="mb-8">
            <h1 className="text-4xl font-bold text-glow mb-2">{title}</h1>
            <p className="text-muted-foreground">{description}</p>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
