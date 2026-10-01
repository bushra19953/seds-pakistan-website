"use client";

import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Settings, ExternalLink } from 'lucide-react';
import { useUser } from '@/firebase';
import { useFirestore } from '@/firebase';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';

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
    cacheExpiry?: string;
  };
}

interface MarqueeSectionProps {
  title: string;
  organizations: Organization[];
  sectionKey: 'globalChapters' | 'globalPartners' | 'localSupporters';
  description?: string;
}

function MarqueeSection({ title, organizations, sectionKey, description }: MarqueeSectionProps) {
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());

  const handleImageError = (orgId: string) => {
    setImageErrors(prev => new Set(prev).add(orgId));
  };

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
        /* Scrolling Marquee Animation */
        <div className="relative overflow-hidden">
          <div className="flex animate-marquee whitespace-nowrap">
            {/* First set of items */}
            {organizations.map((org, index) => (
              <MarqueeItem 
                key={`${sectionKey}-first-${org.id}`} 
                org={org} 
                hasError={imageErrors.has(org.id)}
                onImageError={() => handleImageError(org.id)}
              />
            ))}
            {/* Duplicate set for seamless loop */}
            {organizations.map((org, index) => (
              <MarqueeItem 
                key={`${sectionKey}-second-${org.id}`} 
                org={org} 
                hasError={imageErrors.has(org.id)}
                onImageError={() => handleImageError(org.id)}
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
              hasError={imageErrors.has(org.id)}
              onImageError={() => handleImageError(org.id)}
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
  hasError: boolean;
  onImageError: () => void;
  isGrid?: boolean;
}

function MarqueeItem({ org, hasError, onImageError, isGrid = false }: MarqueeItemProps) {
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
              {hasError || !org.logoUrl ? (
                /* Fallback for broken images */
                <div className={`${logoClass} bg-gradient-to-br from-primary/20 to-primary/40 rounded-lg flex items-center justify-center border border-primary/20`}>
                  <span className="text-xs md:text-sm font-medium text-primary text-center px-1">
                    {org.name.split(' ').map(word => word.charAt(0)).join('').slice(0, 2)}
                  </span>
                </div>
              ) : (
                <img
                  src={org.logoUrl}
                  alt={`${org.name} logo`}
                  className={`${logoClass} object-contain rounded-lg bg-white/80 p-1 border border-border/30 group-hover:shadow-lg transition-all duration-300`}
                  onError={onImageError}
                  loading="lazy"
                />
              )}
              
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

interface CredibilityMarqueeProps {
  data?: OrganizationsData; // Optional prop for pre-fetched data (for SSR)
}

export default function CredibilityMarqueeFixed({ data: propData }: CredibilityMarqueeProps = {}) {
  const firestore = useFirestore();
  const [data, setData] = useState<OrganizationsData | null>(propData || null);
  const [loading, setLoading] = useState(!propData); // Only loading if no data provided
  const [error, setError] = useState<string | null>(null);
  const { user, role } = useUser();

  useEffect(() => {
    const fetchOrganizations = async () => {
      try {
        setLoading(true);
        
        if (!firestore) {
          throw new Error('Firestore service unavailable');
        }

        const organizationsCol = collection(firestore, 'organizations');
        const q = query(organizationsCol, orderBy('displayOrder', 'asc'));
        const snapshot = await getDocs(q);
        
        const organizations: Organization[] = snapshot.docs.map(doc => ({
          id: doc.id,
          name: doc.data().name || '',
          logoUrl: doc.data().logoUrl || '',
          websiteUrl: doc.data().websiteUrl || '',
          type: doc.data().type || 'Institutional Partner',
          showOnHomepageMarquee: doc.data().showOnHomepageMarquee || false,
          displayOrder: doc.data().displayOrder || 0,
          isActive: doc.data().isActive !== undefined ? doc.data().isActive : true,
          isGlobal: doc.data().isGlobal !== undefined ? doc.data().isGlobal : true,
          description: doc.data().description || '',
        }));

        // Filter for organizations that should be shown on homepage and are active
        const homepageOrgs = organizations.filter(org => 
          org.showOnHomepageMarquee && org.isActive
        );

        // Separate into three sections as per requirements:
        const globalChapters = homepageOrgs
          .filter(org => org.type === 'National Chapter')
          .sort((a, b) => a.displayOrder - b.displayOrder);

        const globalPartners = homepageOrgs
          .filter(org =>
            ['Institutional Partner', 'Sponsor', 'University'].includes(org.type) &&
            org.isGlobal === true
          )
          .sort((a, b) => a.displayOrder - b.displayOrder);

        const localSupporters = homepageOrgs
          .filter(org => org.type === 'Sponsor' && org.isGlobal === false)
          .sort((a, b) => a.displayOrder - b.displayOrder);

        const result: OrganizationsData = {
          globalChapters,
          globalPartners,
          localSupporters,
          // Legacy fields for backward compatibility
          chapters: globalChapters,
          partners: globalPartners,
          metadata: {
            totalChapters: globalChapters.length,
            totalPartners: globalPartners.length,
            totalLocalSupporters: localSupporters.length,
            timestamp: new Date().toISOString(),
          }
        };

        setData(result);
        setError(null);
      } catch (err) {
        console.error('Error fetching organizations:', err);
        setError(err instanceof Error ? err.message : 'Failed to load organizations');
      } finally {
        setLoading(false);
      }
    };

    // Only fetch if we don't have prop data
    if (!propData) {
      fetchOrganizations();
    } else {
      setLoading(false);
    }
  }, [propData, firestore]);

  const hasAdminAccess = user && role && (
    role === 'superadmin' ||
    role === 'president_national' ||
    role === 'vice_president' ||
    role === 'general_secretary' ||
    role === 'marketing_head' ||
    role === 'advisor'
  );

  // Error state
  if (error && !data) {
    return (
      <section className="py-12 bg-gradient-to-r from-muted/20 via-background to-muted/20 border-y border-border/20">
        <div className="container mx-auto px-4 md:px-6">
          <div className="text-center">
            <h2 className="text-2xl md:text-3xl font-bold text-glow mb-4">
              Our Partners & Chapters
            </h2>
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 max-w-md mx-auto">
              <p className="text-destructive text-sm">
                Unable to load organizations. Please try again later.
              </p>
              {process.env.NODE_ENV === 'development' && (
                <p className="text-xs mt-2 text-muted-foreground">
                  Debug: {error}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Loading state
  if (loading && !data) {
    return (
      <section className="py-12 bg-gradient-to-r from-muted/20 via-background to-muted/20 border-y border-border/20">
        <div className="container mx-auto px-4 md:px-6">
          <div className="text-center mb-8">
            <h2 className="text-2xl md:text-3xl font-bold text-glow mb-2">
              Our Partners & Chapters
            </h2>
            <p className="text-muted-foreground">
              Loading our trusted partners and global chapters...
            </p>
          </div>
          
          <div className="space-y-12">
            {/* Skeleton for Global Chapters */}
            <div>
              <h3 className="text-xl font-semibold mb-6 text-center">Global Chapters</h3>
              <div className="flex animate-marquee whitespace-nowrap">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className="flex-shrink-0 px-4 py-2">
                    <Card className="bg-card/60 backdrop-blur-sm border-border/50 animate-pulse">
                      <CardContent className="p-3 md:p-4 flex items-center justify-center">
                        <div className="w-12 h-12 md:w-16 md:h-16 bg-muted rounded-lg"></div>
                      </CardContent>
                    </Card>
                  </div>
                ))}
              </div>
            </div>

            {/* Skeleton for Global Partners & Sponsors */}
            <div>
              <h3 className="text-xl font-semibold mb-6 text-center">Global Partners & Sponsors</h3>
              <div className="flex animate-marquee whitespace-nowrap">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className="flex-shrink-0 px-4 py-2">
                    <Card className="bg-card/60 backdrop-blur-sm border-border/50 animate-pulse">
                      <CardContent className="p-3 md:p-4 flex items-center justify-center">
                        <div className="w-12 h-12 md:w-16 md:h-16 bg-muted rounded-lg"></div>
                      </CardContent>
                    </Card>
                  </div>
                ))}
              </div>
            </div>

            {/* Skeleton for Local Supporters */}
            <div>
              <h3 className="text-xl font-semibold mb-6 text-center">Our Local Supporters (SEDS Pakistan)</h3>
              <div className="flex animate-marquee whitespace-nowrap">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="flex-shrink-0 px-4 py-2">
                    <Card className="bg-card/60 backdrop-blur-sm border-border/50 animate-pulse">
                      <CardContent className="p-3 md:p-4 flex items-center justify-center">
                        <div className="w-12 h-12 md:w-16 md:h-16 bg-muted rounded-lg"></div>
                      </CardContent>
                    </Card>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // Check if we have any organizations to display
  const hasAnyOrganizations = data && (
    data.globalChapters.length > 0 ||
    data.globalPartners.length > 0 ||
    data.localSupporters.length > 0
  );

  if (!hasAnyOrganizations) {
    return (
      <section className="py-12 bg-gradient-to-r from-muted/20 via-background to-muted/20 border-y border-border/20">
        <div className="container mx-auto px-4 md:px-6">
          <div className="text-center">
            <h2 className="text-2xl md:text-3xl font-bold text-glow mb-4">
              Our Partners & Chapters
            </h2>
            <p className="text-muted-foreground">
              No organizations found. Please check back later.
            </p>
          </div>
        </div>
      </section>
    );
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

      {/* CSS Animations */}
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