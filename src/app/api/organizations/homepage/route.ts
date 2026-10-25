import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { getAdminDiagnostics } from '@/lib/server/firebase-admin';
import { filterPublicOrganizations } from '@/lib/finance/public-org-gate';
import {
  mapSupaOrganizationForHomepage,
  readOrganizationsViaSupa,
} from '@/lib/server/organizations-supa';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Cache configuration - 1 hour cache for homepage data
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

interface CacheEntry {
  data: any;
  timestamp: number;
}

const cache: Map<string, CacheEntry> = new Map();

// Organization types as specified in requirements
export type OrganizationType = 'National Chapter' | 'Institutional Partner' | 'Sponsor' | 'University';

interface Organization {
  id?: string;
  name: string;
  logoUrl: string;
  websiteUrl: string;
  type: OrganizationType;
  showOnHomepageMarquee: boolean;
  displayOrder: number;
  isActive: boolean;
  isGlobal: boolean;
  partnerId?: string | null;
  logoUseGranted?: boolean;
  createdAt?: any;
  updatedAt?: any;
}

export async function GET(request: NextRequest) {
  try {
    console.log('[organizations:homepage] HANDLER_START: Organizations homepage GET handler initiated');
    
    // Check cache first
    const cacheKey = 'homepage_organizations';
    const cached = cache.get(cacheKey);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < CACHE_TTL) {
      console.log('[organizations:homepage] CACHE_HIT: Returning cached data');
      return NextResponse.json(cached.data, { status: 200 });
    }

    // Ensure Admin SDK is initialized per request and acquire Firestore lazily
    const initOk = ensureAdminInitialized();
    console.log('[organizations:homepage] DIAGNOSTIC: ensureAdminInitialized called. initOk =', initOk);
    if (!initOk) {
      console.error('[organizations:homepage] Admin init failed', getAdminDiagnostics());
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    const db = getDb();
    console.log('[organizations:homepage] DIAGNOSTIC: getDb() called. Is db null?', db === null, 'type:', typeof db);
    if (!db) {
      console.error('[organizations:homepage] Firestore not available', getAdminDiagnostics());
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    console.log('[organizations:homepage] DIAGNOSTIC: Fetching collection "organizations"');

    // Supabase seam (step 6): flag ON serves the list from
    // fs_organizations (same mapper defaults, same in-memory filter,
    // same related-party gate below); flag OFF / unconfigured /
    // adapter error falls back to the Firestore read, byte-identical.
    const supaRead = await readOrganizationsViaSupa();
    let organizations: Organization[];
    if (supaRead.status === 'ok') {
      organizations = supaRead.docs
        .map((doc) => mapSupaOrganizationForHomepage(doc) as Organization)
        .filter(org => org.showOnHomepageMarquee && org.isActive);
    } else {
    // Fetch all organizations with homepage marquee flag
    const snap = await db.collection('organizations').get();

    organizations = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data?.name || '',
        logoUrl: data?.logoUrl || '',
        websiteUrl: data?.websiteUrl || '',
        type: data?.type || 'Institutional Partner',
        showOnHomepageMarquee: data?.showOnHomepageMarquee || false,
        displayOrder: data?.displayOrder || 0,
        isActive: data?.isActive || true,
        isGlobal: data?.isGlobal !== undefined ? data.isGlobal : true, // Default to true for backward compatibility
        partnerId: data?.partnerId || null,
        logoUseGranted: data?.logoUseGranted === true,
        createdAt: data?.createdAt,
        updatedAt: data?.updatedAt,
      };
    }).filter(org => org.showOnHomepageMarquee && org.isActive);
    }

    // Related-party logo gate (CH-20, spec 6.5): same server-side gate as
    // /api/organizations. ACCEPTED LIMIT: this route caches for 1 hour,
    // so a gate change (CRM status flip, consent decision) can take up to
    // 1 hour to remove a logo here. Shortening the TTL or adding cache
    // invalidation on gate changes is a follow-up, not part of this MVP.
    const gatedOrganizations = await filterPublicOrganizations(db, organizations);

    // Separate into three sections as per requirements:
    // 1. Global Chapters - All National Chapters
    const globalChapters = gatedOrganizations
      .filter(org => org.type === 'National Chapter')
      .sort((a, b) => a.displayOrder - b.displayOrder);

    // 2. Global Partners & Sponsors - Institutional Partners, Sponsors, and Universities that are global
    const globalPartners = gatedOrganizations
      .filter(org =>
        ['Institutional Partner', 'Sponsor', 'University'].includes(org.type) &&
        org.isGlobal === true
      )
      .sort((a, b) => a.displayOrder - b.displayOrder);

    // 3. Local Supporters (SEDS Pakistan) - Sponsors that are local (not global)
    const localSupporters = gatedOrganizations
      .filter(org => org.type === 'Sponsor' && org.isGlobal === false)
      .sort((a, b) => a.displayOrder - b.displayOrder);

    const responseData = {
      globalChapters,
      globalPartners,
      localSupporters,
      // Keep legacy fields for backward compatibility
      chapters: globalChapters,
      partners: globalPartners,
      metadata: {
        totalChapters: globalChapters.length,
        totalPartners: globalPartners.length,
        totalLocalSupporters: localSupporters.length,
        timestamp: new Date().toISOString(),
        cacheExpiry: new Date(now + CACHE_TTL).toISOString(),
      }
    };

    // Cache the response
    cache.set(cacheKey, {
      data: responseData,
      timestamp: now
    });

    console.log('[organizations:homepage] SUCCESS: Returning organizations payload', {
      globalChapters: globalChapters.length,
      globalPartners: globalPartners.length,
      localSupporters: localSupporters.length
    });

    return NextResponse.json(responseData, { status: 200 });
  } catch (error: any) {
    console.error('HANDLER_ERROR: [organizations:homepage] Exception in GET handler', error);
    console.error('API_CRASH_DETAILS: [organizations:homepage] GET error', {
      message: error?.message,
      stack: error?.stack
    });
    
    return NextResponse.json(
      { 
        error: error?.message || 'Failed to load organizations',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}

// Clear cache endpoint for admin use
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    
    if (action === 'clear-cache') {
      cache.clear();
      console.log('[organizations:homepage] CACHE_CLEAR: Cache cleared by admin request');
      return NextResponse.json({ 
        message: 'Cache cleared successfully',
        timestamp: new Date().toISOString()
      });
    }
    
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error: any) {
    console.error('CACHE_CLEAR_ERROR: [organizations:homepage] Failed to clear cache', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to clear cache' },
      { status: 500 }
    );
  }
}