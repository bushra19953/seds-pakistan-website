"use client";

import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Users, FolderOpen, HandHeart, Globe2 } from 'lucide-react';
import { useSiteSettings } from '@/hooks/use-site-settings';
import { useUser } from '@/firebase';

interface TrustBarMetric {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  suffix?: string;
}

export default function TrustBar() {
  const { settings, loading, error } = useSiteSettings();
  const { user, role, allowedPaths } = useUser();

  const metrics: TrustBarMetric[] = useMemo(() => [
    {
      label: 'Students Engaged',
      value: settings?.studentsEngaged || 0,
      icon: Users,
      description: 'Active members across all chapters'
    },
    {
      label: 'Active Projects',
      value: settings?.activeProjects || 0,
      icon: FolderOpen,
      description: 'Projects currently in development'
    },
    {
      label: 'Partners',
      value: settings?.partners || 0,
      icon: HandHeart,
      description: 'Strategic partnerships and sponsors'
    },
    {
      label: 'Global Chapters',
      value: settings?.globalChapters || 25,
      icon: Globe2,
      description: 'SEDS chapters worldwide',
      suffix: '+'
    }
  ], [settings]);

  const hasAdminAccess = user && role && (
    role === 'superadmin' || 
    allowedPaths.includes('/admin/site-settings') ||
    allowedPaths.includes('all') ||
    allowedPaths.includes('*')
  );

  // Graceful degradation: Don't render if there's an error or no settings
  if (error || !settings) {
    return null;
  }

  return (
    <section
      className="py-12 bg-transparent border-y border-primary/20"
      aria-label="Organization Statistics"
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-8">
          <h2 className="text-2xl md:text-3xl font-bold mb-2 text-foreground">
            Our Impact & Credibility
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Real numbers from our growing community of space enthusiasts and innovators
          </p>
        </div>

        {/* Admin Edit Link */}
        {hasAdminAccess && (
          <div className="text-center mb-6">
            <a
              href="/admin/site-settings"
              className="inline-flex items-center gap-2 text-sm text-primary hover:text-primary/80 underline underline-offset-4 transition-colors"
            >
              <span>📊 Edit These Numbers</span>
            </a>
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[...Array(4)].map((_, index) => (
              <Card key={index} className="bg-card/60 backdrop-blur-sm border-border/50 animate-pulse">
                <CardContent className="p-6 text-center">
                  <div className="w-12 h-12 bg-muted rounded-full mx-auto mb-4"></div>
                  <div className="h-8 bg-muted rounded mb-2"></div>
                  <div className="h-4 bg-muted rounded w-3/4 mx-auto"></div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {metrics.map((metric, index) => {
              const Icon = metric.icon;

              return (
                <Card
                  key={metric.label}
                  className="bg-card/80 backdrop-blur-sm border-border/50 hover:border-primary/50 transition-all duration-300 group"
                >
                  <CardContent className="p-6 text-center">
                    <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:bg-primary/20 transition-colors">
                      <Icon className="h-6 w-6 text-primary" />
                    </div>

                    <div className="space-y-1">
                      <h3 className="text-2xl md:text-3xl font-bold text-foreground">
                        {metric.value.toLocaleString()}{metric.suffix || ''}
                      </h3>
                      <p className="text-sm font-medium text-primary">
                        {metric.label}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {metric.description}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Last Updated Info */}
        {settings.updatedAt && !loading && (
          <div className="text-center mt-8 text-xs text-muted-foreground">
            <p>
              Last updated: {settings.updatedAt.toDate ? settings.updatedAt.toDate().toLocaleDateString() : 'Recently'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}