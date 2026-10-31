import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/server/firebase-admin';
import { queryCatalogue } from '@/lib/server/store-catalogue';
import type { CatalogueQuery, CatalogueSort } from '@/types/store-catalogue';

export const dynamic = 'force-dynamic';

const SORTS: CatalogueSort[] = ['price_asc', 'price_desc', 'newest'];

function parsePriceParam(raw: string | null): { value?: number; error?: string } {
  if (raw === null) return {};
  if (!/^\d+$/.test(raw.trim())) return { error: 'must be a non-negative integer' };
  return { value: parseInt(raw.trim(), 10) };
}

/**
 * GET /api/store/catalogue: the public catalogue (PLAN-gd Section 3).
 * No auth. Reads per request: 1 vendors query + 1 products query
 * (capped at 1000), handled inside queryCatalogue.
 */
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Firestore not initialized' }, { status: 500 });
    }

    const params = request.nextUrl.searchParams;

    const qRaw = params.get('q');
    const q = qRaw ? qRaw.trim() : '';
    if (q.length > 100) {
      return NextResponse.json({ error: 'q is too long' }, { status: 400 });
    }

    const inStockRaw = params.get('inStock');
    let inStock: boolean | undefined;
    if (inStockRaw !== null) {
      if (inStockRaw === 'true') inStock = true;
      else if (inStockRaw === 'false') inStock = false;
      else return NextResponse.json({ error: 'inStock must be true or false' }, { status: 400 });
    }

    const minParsed = parsePriceParam(params.get('minPrice'));
    if (minParsed.error) {
      return NextResponse.json({ error: `minPrice ${minParsed.error}` }, { status: 400 });
    }
    const maxParsed = parsePriceParam(params.get('maxPrice'));
    if (maxParsed.error) {
      return NextResponse.json({ error: `maxPrice ${maxParsed.error}` }, { status: 400 });
    }
    if (
      minParsed.value !== undefined &&
      maxParsed.value !== undefined &&
      minParsed.value > maxParsed.value
    ) {
      return NextResponse.json(
        { error: 'minPrice must not be greater than maxPrice' },
        { status: 400 },
      );
    }

    const sortRaw = params.get('sort');
    let sort: CatalogueSort = 'newest';
    if (sortRaw !== null) {
      if ((SORTS as string[]).includes(sortRaw)) sort = sortRaw as CatalogueSort;
      else {
        return NextResponse.json(
          { error: 'sort must be one of price_asc, price_desc, newest' },
          { status: 400 },
        );
      }
    }

    const query: CatalogueQuery = {
      q: q || undefined,
      inStock,
      minPrice: minParsed.value,
      maxPrice: maxParsed.value,
      sort,
    };
    const products = await queryCatalogue(db, query);
    return NextResponse.json({ ok: true, products, count: products.length });
  } catch (e: any) {
    console.error('[catalogue API] GET error:', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
