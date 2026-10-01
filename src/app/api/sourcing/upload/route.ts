import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getAdminStorage } from '@/lib/server/firebase-admin';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const cleanFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const timestamp = Date.now();
    const uniqueFilename = `${timestamp}_${cleanFilename}`;
    const storagePath = `sourcing-cad-packages/${uniqueFilename}`;

    let downloadUrl = '';

    try {
      ensureAdminInitialized();
      const storageAdmin = getAdminStorage();
      if (storageAdmin) {
        const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'seds-pakistan.appspot.com';
        const bucket = storageAdmin.bucket(bucketName);
        const fileRef = bucket.file(storagePath);
        const buffer = Buffer.from(await file.arrayBuffer());
        const downloadToken = crypto.randomUUID();

        await fileRef.save(buffer, {
          metadata: {
            contentType: file.type || 'application/octet-stream',
            metadata: {
              firebaseStorageDownloadTokens: downloadToken,
            },
          },
          resumable: false,
        });

        // Firebase Storage Token URL
        downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;
      }
    } catch (storageErr) {
      console.warn('Firebase Admin Storage upload error in route:', storageErr);
    }

    if (!downloadUrl) {
      downloadUrl = `/api/sourcing/download/${encodeURIComponent(uniqueFilename)}`;
    }

    return NextResponse.json({
      success: true,
      fileUrl: downloadUrl,
      downloadUrl: downloadUrl,
      filename: uniqueFilename,
      size: file.size,
    });
  } catch (error: any) {
    console.error('Error in /api/sourcing/upload:', error);
    return NextResponse.json({ error: error.message || 'File upload failed' }, { status: 500 });
  }
}
