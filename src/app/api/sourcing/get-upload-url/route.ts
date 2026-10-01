import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getAdminStorage } from '@/lib/server/firebase-admin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { filename, contentType } = await req.json();

    if (!filename) {
      return NextResponse.json({ error: 'Filename is required' }, { status: 400 });
    }

    const cleanFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueFilename = `${Date.now()}_${cleanFilename}`;
    const storagePath = `sourcing-cad-packages/${uniqueFilename}`;

    ensureAdminInitialized();
    const storageAdmin = getAdminStorage();

    if (storageAdmin) {
      const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'seds-pakistan.appspot.com';
      const bucket = storageAdmin.bucket(bucketName);
      const fileRef = bucket.file(storagePath);

      // Generate v4 signed PUT URL for direct browser-to-GCS upload (supports 100MB+)
      try {
        const [uploadUrl] = await fileRef.getSignedUrl({
          version: 'v4',
          action: 'write',
          expires: Date.now() + 30 * 60 * 1000, // 30 minutes
          contentType: contentType || 'application/octet-stream',
        });

        // Generate long-term read download URL
        let downloadUrl = '';
        try {
          const [readUrl] = await fileRef.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: '03-01-2036',
          });
          downloadUrl = readUrl;
        } catch (_readErr) {
          downloadUrl = `https://storage.googleapis.com/${bucketName}/${storagePath}`;
        }

        return NextResponse.json({
          success: true,
          uploadUrl,
          downloadUrl,
          uniqueFilename,
          storagePath,
        });
      } catch (signErr: any) {
        console.warn('GCS Signed URL generation warning:', signErr?.message || signErr);
      }
    }

    // Fallback direct public Google Cloud Storage URL
    const fallbackDownloadUrl = `https://firebasestorage.googleapis.com/v0/b/seds-pakistan.appspot.com/o/${encodeURIComponent(storagePath)}?alt=media`;

    return NextResponse.json({
      success: true,
      uploadUrl: '',
      downloadUrl: fallbackDownloadUrl,
      uniqueFilename,
      storagePath,
    });
  } catch (error: any) {
    console.error('Error in /api/sourcing/get-upload-url:', error);
    return NextResponse.json({ error: error.message || 'Failed to generate upload URL' }, { status: 500 });
  }
}
