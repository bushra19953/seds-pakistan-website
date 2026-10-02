/**
 * POST /api/sourcing/upload
 *
 * CAD package upload endpoint for the Sourcing Bridge RFQ pipeline.
 * Delegates to the shared Drive upload handler with kind=cad, so files land
 * in the "SEDS CAD Vault" folder (zero-cost replacement for Firebase Storage,
 * which requires a paid plan).
 *
 * Requires a signed-in user (verifySession). Fails closed when the Drive
 * service account is not configured.
 */

import { NextRequest } from 'next/server';
import { handleDriveUpload } from '@/lib/drive/upload-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Map legacy field names onto the shared handler's contract.
  return handleDriveUpload(request, 'cad');
}
