// GET /api/categories - Retrieve all blog categories
import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const includeCounts = searchParams.get('includeCounts') === 'true';

    // Ensure Firebase Admin is initialized before getting db
    const initOk = ensureAdminInitialized();
    if (!initOk) {
      throw new Error('Server misconfiguration: Firebase Admin not initialized');
    }

    // Get all unique categories from blog posts
    const db = getDb();
    if (!db) {
      throw new Error('Database connection failed');
    }
    
    const blogsRef = db.collection('blogs');
    const q = blogsRef.where('status', '==', 'published');
    const querySnapshot = await q.get();

    const categoriesMap = new Map();

    querySnapshot.forEach((doc) => {
      const data = doc.data() as any;
      const categoryId = data.categoryId;
      const categoryName = data.categoryName || categoryId || 'Uncategorized';

      // Only add valid, non-empty category IDs
      if (categoryId && typeof categoryId === 'string' && categoryId.trim() !== '') {
        const sanitizedId = categoryId.trim();
        if (!categoriesMap.has(sanitizedId)) {
          categoriesMap.set(sanitizedId, {
            id: sanitizedId,
            name: categoryName.trim() || 'Uncategorized',
            postCount: 0,
            slug: sanitizedId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          });
        }

        const category = categoriesMap.get(sanitizedId);
        category.postCount++;
      }
    });

    // If no categories found, create a default "General" category
    const categories = categoriesMap.size > 0
      ? Array.from(categoriesMap.values()).sort((a, b) => b.postCount - a.postCount)
      : [{
          id: 'general',
          name: 'General',
          postCount: 0,
          slug: 'general',
        }];

    // CRITICAL SERVER-SIDE VALIDATION: Verify all categories have valid IDs before sending to client
    console.log('[/api/categories] SERVER-SIDE DEBUG: Total categories before validation:', categories.length);

    const validCategories = categories.filter(category => {
      const isValid = category &&
                     category.id &&
                     typeof category.id === 'string' &&
                     category.id.trim().length > 0;

      if (!isValid) {
        console.error('🚨🚨🚨 SERVER-SIDE CRITICAL: FOUND INVALID CATEGORY OBJECT IN API RESPONSE !!!', {
          category,
          categoryType: typeof category,
          categoryId: category?.id,
          categoryIdType: typeof category?.id
        });
      }

      return isValid;
    });

    console.log('[/api/categories] SERVER-SIDE DEBUG: Valid categories after validation:', validCategories.length);

    if (validCategories.length !== categories.length) {
      console.error('🚨 SERVER-SIDE WARNING: Filtered out', categories.length - validCategories.length, 'invalid category/categories');
    }

    return NextResponse.json({
      categories: validCategories,
      totalCount: validCategories.length
    }, { headers: { 'Cache-Control': 's-maxage=600, stale-while-revalidate=86400' } });

  } catch (error) {
    console.error('Error fetching categories:', error);
    return NextResponse.json(
      { error: 'Failed to fetch categories' },
      { status: 500 }
    );
  }
}

// POST /api/admin/categories - Create a new category (admin/editor role)
export async function POST(request: NextRequest) {
  try {
    // TODO: Add proper authentication and role checking
    const body = await request.json();
    
    const { name, description } = body;

    if (!name) {
      return NextResponse.json(
        { error: 'Category name is required' },
        { status: 400 }
      );
    }

    // Generate category ID from name
    const categoryId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const categoryData = {
      id: categoryId,
      name,
      description: description || '',
      slug: categoryId,
      createdAt: new Date(),
      postCount: 0,
    };

    // Add to Firestore (using a categories collection)
    // Note: This assumes a separate categories collection exists
    // If not, categories are derived from blog posts
    return NextResponse.json({
      category: categoryData,
      message: 'Category created successfully'
    });

  } catch (error) {
    console.error('Error creating category:', error);
    return NextResponse.json(
      { error: 'Failed to create category' },
      { status: 500 }
    );
  }
}
