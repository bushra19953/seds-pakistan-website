/**
 * POST /api/uploads
 *
 * General Drive-backed upload endpoint. The `kind` form field selects the
 * destination folder and validation rules (cad | image | bug | document |
 * receipt). Each kind has its own top-level folder in the site owner's Drive.
 *
 * Requires a signed-in user (verifySession). Fails closed when Drive is
 * not configured.
 */

import { NextRequest } from 'next/server';
import { handleDriveUpload } from '@/lib/drive/upload-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return handleDriveUpload(request, 'image');
}
