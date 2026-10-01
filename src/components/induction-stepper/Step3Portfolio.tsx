import { useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import React, { useState, useEffect, useRef } from 'react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import GoogleDriveUpload from './GoogleDriveUpload';

export default function Step3Portfolio() {
  const { register, watch, formState: { errors } } = useFormContext();
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Resume Upload (Google Drive)</CardTitle>
          <CardDescription>
            Please upload your resume to Google Drive, set the sharing permissions to <strong>"Anyone with the link"</strong>, and paste the link below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div>
            <Label htmlFor="resumeUpload" className="text-base font-semibold">Google Drive Link <span className="text-red-500">*</span></Label>
            <Input
              id="resumeUpload"
              {...register('resumeUpload')}
              placeholder="https://drive.google.com/file/d/..."
              className="mt-2"
            />
            {errors.resumeUpload && <p className="text-red-500 text-sm mt-1">{errors.resumeUpload.message?.toString()}</p>}
          </div>
        </CardContent>
      </Card>

      {/* Portfolio and GitHub Links */}
      <div className="space-y-4">
        <div>
          <Label htmlFor="portfolioLink">Portfolio Link</Label>
          <Input id="portfolioLink" {...register('portfolioLink')} placeholder="https://your-portfolio.com" />
          {errors.portfolioLink && <p className="text-red-500 text-sm">{errors.portfolioLink.message?.toString()}</p>}
        </div>
        <div>
          <Label htmlFor="githubLink">GitHub Link</Label>
          <Input id="githubLink" {...register('githubLink')} placeholder="https://github.com/your-profile" />
          {errors.githubLink && <p className="text-red-500 text-sm">{errors.githubLink.message?.toString()}</p>}
        </div>
      </div>
    </div>
  );
}
