"use client";

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Settings, ExternalLink } from 'lucide-react';
import { useUser } from '@/firebase';

interface Organization {
  id: string;
  name: string;
  logoUrl: string;
  websiteUrl: string;
  type: 'National Chapter' | 'Institutional Partner' | 'Sponsor' | 'University';
  showOnHomepageMarquee: boolean;
  displayOrder: number;
  isActive: boolean;
  isGlobal: boolean;
  description?: string;
}

interface OrganizationsData {
  globalChapters: Organization[];
  globalPartners: Organization[];
  localSupporters: Organization[];
  // Legacy fields for backward compatibility
  chapters?: Organization[];
  partners?: Organization[];
  metadata: {
    totalChapters: number;
    totalPartners: number;
    totalLocalSupporters?: number;
    timestamp: string;
    cacheExpiry: string;
  };
}

interface CredibilityMarqueeProps {
  data: OrganizationsData; // Required prop for pre-fetched data (for SSR)
}

interface MarqueeSectionProps {
  title: string;
  organizations: Organization[];
  sectionKey: 'globalChapters' | 'globalPartners' | 'localSupporters';
  description?: string;
}

function MarqueeSection({ title, organizations, sectionKey, description }: MarqueeSectionProps) {
  // Graceful degradation: If few items, show static grid instead of marquee
  const shouldUseMarquee = organizations.length > 6;

  if (organizations.length === 0) {
    return null;
  }

  return (
    <div className="py-8">
      <div className="text-center mb-6">
        <h3 className="text-xl md:text-2xl font-semibold text-glow mb-2">{title}</h3>
        {description && (
          <p className="text-sm text-muted-foreground mb-2">{description}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {organizations.length} organization{organizations.length !== 1 ? 's' : ''}
        </p>
      </div>

      {shouldUseMarquee ? (
        /* Scrolling Marquee Animation - Optimized for GPU */
        <div className="relative overflow-hidden">
          <div className="flex animate-marquee whitespace-nowrap">
            {/* First set of items */}
            {organizations.map((org, index) => (
              <MarqueeItem 
                key={`${sectionKey}-first-${org.id}`} 
                org={org}
              />
            ))}
            {/* Duplicate set for seamless loop */}
            {organizations.map((org, index) => (
              <MarqueeItem 
                key={`${sectionKey}-second-${org.id}`} 
                org={org}
              />
            ))}
          </div>
        </div>
      ) : (
        /* Static Grid for Fewer Items */
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
          {organizations.map((org) => (
            <MarqueeItem 
              key={`${sectionKey}-grid-${org.id}`} 
              org={org}
              isGrid={true}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface MarqueeItemProps {
  org: Organization;
  isGrid?: boolean;
}

function MarqueeItem({ org, isGrid = false }: MarqueeItemProps) {
  const containerClass = isGrid 
    ? "flex-shrink-0 p-4" 
    : "flex-shrink-0 px-4 py-2";
  
  const logoClass = isGrid 
    ? "w-16 h-16 md:w-20 md:h-20" 
    : "w-12 h-12 md:w-16 md:h-16";

  return (
    <div className={containerClass}>
      <a
        href={org.websiteUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block group"
        aria-label={`Visit ${org.name} website`}
      >
        <Card className="bg-card/60 backdrop-blur-sm border-border/50 hover:border-primary/50 transition-all duration-300 group-hover:scale-105">
          <CardContent className="p-3 md:p-4 flex items-center justify-center">
            <div className="relative">
              <img
                src={org.logoUrl}
                alt={`${org.name} logo`}
                className={`${logoClass} object-contain rounded-lg bg-white/80 p-1 border border-border/30 group-hover:shadow-lg transition-all duration-300`}
                onError={(e) => {
                  // Fallback for broken images - hide broken image
                  e.currentTarget.style.display = 'none';
                }}
                loading="eager" // SSR loaded - images should load eagerly
              />
              
              {/* External link indicator */}
              <div className="absolute -top-1 -right-1 w-4 h-4 bg-primary/80 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <ExternalLink className="w-2 h-2 text-white" />
              </div>
            </div>
          </CardContent>
        </Card>
      </a>
    </div>
  );
}

export default function CredibilityMarqueeSSR({ data }: CredibilityMarqueeProps) {
  const { user, role } = useUser();

  const hasAdminAccess = user && role && (
    role === 'superadmin' ||
    role === 'president_national' ||
    role === 'vice_president' ||
    role === 'general_secretary' ||
    role === 'marketing_head' ||
    role === 'advisor' ||
    role === 'projects_director' ||
    role === 'chair_projects' ||
    role === 'hr_director' ||
    role === 'treasurer' ||
    role === 'chair_events'
  );

  // Check if we have any organizations to display
  const hasAnyOrganizations = data && (
    data.globalChapters.length > 0 ||
    data.globalPartners.length > 0 ||
    data.localSupporters.length > 0
  );

  if (!hasAnyOrganizations) {
    return null;
  }

  return (
    <section
      className="py-12 bg-gradient-to-r from-muted/20 via-background to-muted/20 border-y border-border/20"
      aria-label="Organization Partners and Chapters"
    >
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-8">
          <h2 className="text-2xl md:text-3xl font-bold text-glow mb-2">
            Our Partners & Chapters
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Collaborating with leading organizations, universities, and space agencies worldwide
          </p>
        </div>

        {/* Admin Quick Edit Button */}
        {hasAdminAccess && (
          <div className="text-center mb-8">
            <a
              href="/admin/organizations"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary/10 hover:bg-primary/20 border border-primary/30 rounded-lg text-primary transition-colors"
            >
              <Settings className="w-4 h-4" />
              <span>Manage Organizations</span>
            </a>
          </div>
        )}

        {/* Metadata Display */}
        {data?.metadata && (
          <div className="text-center mb-6 text-xs text-muted-foreground">
            <p>
              Last updated: {new Date(data.metadata.timestamp).toLocaleDateString()} •
              {' '}{data.metadata.totalChapters} chapters • {data.metadata.totalPartners} global partners
              {data.metadata.totalLocalSupporters !== undefined && data.metadata.totalLocalSupporters > 0 && (
                <> • {data.metadata.totalLocalSupporters} local supporters</>
              )}
            </p>
          </div>
        )}

        <div className="space-y-12">
          {/* Section 1: Global Chapters */}
          {data.globalChapters.length > 0 && (
            <MarqueeSection
              title="Global Chapters"
              description="SEDS chapters around the world"
              organizations={data.globalChapters}
              sectionKey="globalChapters"
            />
          )}

          {/* Section 2: Global Partners & Sponsors */}
          {data.globalPartners.length > 0 && (
            <MarqueeSection
              title="Global Partners & Sponsors"
              description="International organizations and institutional partners"
              organizations={data.globalPartners}
              sectionKey="globalPartners"
            />
          )}

          {/* Section 3: Local Supporters (SEDS Pakistan) */}
          {data.localSupporters.length > 0 && (
            <MarqueeSection
              title="Our Local Supporters (SEDS Pakistan)"
              description="Pakistani organizations supporting our mission"
              organizations={data.localSupporters}
              sectionKey="localSupporters"
            />
          )}
        </div>
      </div>

      {/* CSS Animations - GPU Optimized */}
      <style jsx>{`
        @keyframes marquee {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }
        
        .animate-marquee {
          animation: marquee 30s linear infinite;
          will-change: transform; /* GPU optimization hint */
        }
        
        .animate-marquee:hover {
          animation-play-state: paused;
        }
        
        @media (prefers-reduced-motion: reduce) {
          .animate-marquee {
            animation: none;
          }
        }
        
        @media (max-width: 768px) {
          .animate-marquee {
            animation-duration: 40s;
          }
        }
      `}</style>
    </section>
  );
}