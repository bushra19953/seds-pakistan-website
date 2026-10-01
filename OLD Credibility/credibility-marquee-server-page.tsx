import CredibilityMarqueeSSR from './credibility-marquee-ssr';

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

// Server-side data fetching - happens during build/generation
async function fetchOrganizationsServer(): Promise<OrganizationsData> {
  try {
    // For development
    const baseUrl = process.env.NODE_ENV === 'development' 
      ? 'http://localhost:9004' 
      : process.env.VERCEL_URL 
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:9004';
    
    const response = await fetch(`${baseUrl}/api/organizations/homepage`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      // Cache for 1 hour - revalidate every hour
      next: { revalidate: 3600 }
    });

    if (!response.ok) {
      console.error('Server-side fetch failed:', response.status);
      return {
        globalChapters: [],
        globalPartners: [],
        localSupporters: [],
        chapters: [],
        partners: [],
        metadata: {
          totalChapters: 0,
          totalPartners: 0,
          totalLocalSupporters: 0,
          timestamp: new Date().toISOString(),
          cacheExpiry: new Date(Date.now() + 3600000).toISOString()
        }
      };
    }

    return await response.json();
  } catch (error) {
    console.error('Server-side fetch error:', error);
    return {
      globalChapters: [],
      globalPartners: [],
      localSupporters: [],
      chapters: [],
      partners: [],
      metadata: {
        totalChapters: 0,
        totalPartners: 0,
        totalLocalSupporters: 0,
        timestamp: new Date().toISOString(),
        cacheExpiry: new Date(Date.now() + 3600000).toISOString()
      }
    };
  }
}

// Main server component
export default async function CredibilityMarqueeServerPage() {
  // This runs on the server - data is fetched before HTML is sent
  const data = await fetchOrganizationsServer();
  
  // Client component receives pre-fetched data - no loading state
  return <CredibilityMarqueeSSR data={data} />;
}