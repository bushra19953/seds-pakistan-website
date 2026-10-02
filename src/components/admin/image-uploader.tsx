"use client";

import { useState } from 'react';
import { useUser } from '@/firebase';
import { uploadToDrive } from '@/lib/uploads/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Loader2, Upload, X, CheckCircle2 } from 'lucide-react';
import Image from 'next/image';

interface ImageUploaderProps {
    onUploadComplete: (url: string) => void;
    /** Unused legacy Storage path; kept for prop compatibility. */
    path?: string;
}

export default function ImageUploader({ onUploadComplete, path = 'uploads/general' }: ImageUploaderProps) {
    void path;
    const { user } = useUser();
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [preview, setPreview] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Validate file type
        if (!file.type.startsWith('image/')) {
            setError('Please select an image file.');
            return;
        }

        // Validate size (max 5MB)
        if (file.size > 5 * 1024 * 1024) {
            setError('File size must be less than 5MB.');
            return;
        }

        setError(null);
        setUploading(true);
        setProgress(0);

        // Create a local preview
        const reader = new FileReader();
        reader.onload = (event) => {
            setPreview(event.target?.result as string);
        };
        reader.readAsDataURL(file);

        try {
            if (!user) {
                setError('Sign in to upload.');
                setUploading(false);
                return;
            }
            const idToken = await user.getIdToken();
            const uploaded = await uploadToDrive(file, idToken, {
                kind: 'image',
                context: 'admin',
                onProgress: (p) => setProgress(p),
            });
            onUploadComplete(uploaded.downloadUrl);
            setUploading(false);
            setPreview(null);
        } catch (err) {
            console.error('Upload exception:', err);
            setError(err instanceof Error ? err.message : 'Something went wrong during upload.');
            setUploading(false);
        }
    };

    return (
        <div className="space-y-4 border-2 border-dashed border-muted rounded-lg p-6 text-center hover:border-primary/50 transition-colors">
            {!uploading && !preview && (
                <div className="flex flex-col items-center gap-2">
                    <Upload className="h-8 w-8 text-muted-foreground" />
                    <div className="text-sm">
                        <label htmlFor="image-upload" className="cursor-pointer text-primary hover:underline font-medium">
                            Click to upload
                        </label>
                        <span className="text-muted-foreground"> or drag and drop</span>
                    </div>
                    <p className="text-xs text-muted-foreground">PNG, JPG or WEBP (max. 5MB)</p>
                    <Input
                        id="image-upload"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleFileChange}
                    />
                </div>
            )}

            {uploading && (
                <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-2">
                            <Loader2 className="h-3 w-3 animate-spin" /> Uploading...
                        </span>
                        <span>{Math.round(progress)}%</span>
                    </div>
                    <Progress value={progress} className="h-2" />
                    {preview && (
                        <div className="relative w-full aspect-video rounded-md overflow-hidden bg-muted">
                            <Image
                                src={preview}
                                alt="Preview"
                                fill
                                sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 800px"
                                className="object-contain opacity-50"
                            />
                        </div>
                    )}
                </div>
            )}

            {error && (
                <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 p-2 rounded">
                    <X className="h-3 w-3" /> {error}
                </div>
            )}
        </div>
    );
}
