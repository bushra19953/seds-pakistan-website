// Server-side component for Credibility Marquee
// This fetches data during server-side rendering for instant loading
import { getDb } from '@/lib/server/firebase-admin';

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

export default async function CredibilityMarqueeServer() {
  try {
    console.log('[CredibilityMarqueeServer] Fetching organizations for homepage marquee...');
    
    const db = getDb();
    if (!db) {
      console.warn('[CredibilityMarqueeServer] Database not available');
      return null;
    }

    // Fetch all organizations marked for homepage display
    const query = db.collection('organizations')
      .where('isActive', '==', true)
      .orderBy('displayOrder', 'asc')
      .orderBy('name', 'asc');

    const querySnapshot = await query.get();
    const organizations: Organization[] = [];

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.logoUrl && data.name) {
        organizations.push({
          id: doc.id,
          name: data.name,
          logoUrl: data.logoUrl,
          websiteUrl: data.websiteUrl || '#',
          type: data.type || 'National Chapter',
          showOnHomepageMarquee: data.showOnHomepageMarquee || false,
          displayOrder: data.displayOrder || 0,
          isActive: data.isActive || false,
          isGlobal: data.isGlobal !== undefined ? data.isGlobal : true,
          description: data.description || '',
        });
      }
    });

    console.log(`[CredibilityMarqueeServer] Found ${organizations.length} total organizations`);

    // Filter for homepage display
    const homepageOrgs = organizations.filter(org => org.showOnHomepageMarquee);

    // Separate into three sections as per requirements:
    // 1. Global Chapters - All National Chapters
    const globalChapters = homepageOrgs
      .filter(org => org.type === 'National Chapter')
      .sort((a, b) => a.displayOrder - b.displayOrder);

    // 2. Global Partners & Sponsors - Institutional Partners, Sponsors, and Universities that are global
    const globalPartners = homepageOrgs
      .filter(org =>
        ['Institutional Partner', 'Sponsor', 'University'].includes(org.type) &&
        org.isGlobal === true
      )
      .sort((a, b) => a.displayOrder - b.displayOrder);

    // 3. Local Supporters (SEDS Pakistan) - Sponsors that are local (not global)
    const localSupporters = homepageOrgs
      .filter(org => org.type === 'Sponsor' && org.isGlobal === false)
      .sort((a, b) => a.displayOrder - b.displayOrder);

    console.log(`[CredibilityMarqueeServer] Filtered for homepage: ${globalChapters.length} chapters, ${globalPartners.length} global partners, ${localSupporters.length} local supporters`);

    // If no organizations are configured for homepage, don't render the section
    if (globalChapters.length === 0 && globalPartners.length === 0 && localSupporters.length === 0) {
      console.log('[CredibilityMarqueeServer] No organizations configured for homepage marquee');
      return null;
    }

    // Create the data structure expected by the client component
    const data: OrganizationsData = {
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
        cacheExpiry: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minutes
      }
    };

    // Import client component dynamically to avoid SSR issues
    const CredibilityMarqueeClient = await import('./credibility-marquee');
    
    // Return the client component with pre-fetched data
    return (
      <CredibilityMarqueeClient.default 
        data={data}
      />
    );

  } catch (error) {
    console.error('[CredibilityMarqueeServer] Error fetching organizations:', error);
    // On error, don't render anything to avoid broken experience
    return null;
  }
}