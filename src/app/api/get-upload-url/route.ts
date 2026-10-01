import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Section 5.1: Cloud File Upload Pre-Signed URL Generator
 * GET /api/get-upload-url?filename=part.step
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const filename = searchParams.get('filename') || 'cad_package.step';

    const cleanFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const uniqueFilename = `${timestamp}_${cleanFilename}`;

    const uploadUrl = `https://storage.sedspakistan.org/cad-uploads/${uniqueFilename}`;

    return NextResponse.json({
      success: true,
      uploadUrl,
      downloadUrl: uploadUrl,
      filename: uniqueFilename,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
