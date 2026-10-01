"use client";

import { useFormContext } from 'react-hook-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Step4Review({ fields = [] }: { fields?: any[] }) {
  const { watch } = useFormContext();
  const formData = watch();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Review Your Application</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {fields.sort((a, b) => (a.order || 0) - (b.order || 0)).map(field => {
            const val = formData[field.name];
            const displayVal = Array.isArray(val) ? val.join(', ') : val;
            return (
              <div key={field.id} className="text-sm">
                <span className="font-semibold">{field.label}:</span> <span className="text-muted-foreground">{displayVal || 'N/A'}</span>
              </div>
            );
          })}

          <div className="border-t my-4 pt-4 space-y-2">
            <div className="text-sm"><span className="font-semibold">Portfolio Link:</span> <span className="text-muted-foreground">{formData.portfolioLink || 'N/A'}</span></div>
            <div className="text-sm"><span className="font-semibold">GitHub Link:</span> <span className="text-muted-foreground">{formData.githubLink || 'N/A'}</span></div>
            <div className="text-sm"><span className="font-semibold">Resume Link:</span> <span className="text-muted-foreground break-all">{formData.resumeUpload || 'No link provided'}</span></div>
          </div>
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">Please review all your information carefully before submitting.</p>
    </div>
  );
}
