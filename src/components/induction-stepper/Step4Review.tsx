"use client";

import { useFormContext } from 'react-hook-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Review step. All steps stay mounted (hidden with CSS) for the whole
 * session, so a plain watch() here would re-render this subtree on
 * every keystroke typed into any earlier step. The page passes
 * `active` (true only while this is the visible step): while hidden we
 * render a one-off getValues() snapshot with no subscription, and the
 * live watch() version mounts the moment the step becomes visible, so
 * what the applicant sees on the review step is always current.
 * `active` defaults to true so direct renders keep the live behavior.
 */
export default function Step4Review({ fields = [], active = true }: { fields?: any[]; active?: boolean }) {
  return active ? <Step4ReviewLive fields={fields} /> : <Step4ReviewSnapshot fields={fields} />;
}

function Step4ReviewLive({ fields = [] }: { fields?: any[] }) {
  const { watch } = useFormContext();
  const formData = watch();
  return <ReviewBody fields={fields} formData={formData} />;
}

function Step4ReviewSnapshot({ fields = [] }: { fields?: any[] }) {
  const { getValues } = useFormContext();
  return <ReviewBody fields={fields} formData={getValues()} />;
}

function ReviewBody({ fields = [], formData }: { fields?: any[]; formData: any }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Review Your Application</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {[...fields].sort((a, b) => (a.order || 0) - (b.order || 0)).map(field => {
            const val = formData[field.name];
            // Select-type fields (e.g. Target Chapter, Preferred Track) show
            // the option label instead of the raw stored value.
            const displayVal = Array.isArray(val)
              ? val.join(', ')
              : Array.isArray(field.options)
                ? (field.options.find((o: any) => o.value === val)?.label || val)
                : val;
            // A required field left empty must not read as accepted. Flag it
            // in the error color so the reviewer sees what is missing.
            const missingRequired = field.required && !displayVal;
            return (
              <div key={field.id} className="text-sm">
                <span className="font-semibold">{field.label}:</span>{' '}
                <span className={missingRequired ? 'text-red-600 font-medium' : 'text-muted-foreground'}>
                  {missingRequired ? 'Required, not provided' : (displayVal || 'N/A')}
                </span>
              </div>
            );
          })}

          <div className="border-t my-4 pt-4 space-y-2">
            <div className="text-sm"><span className="font-semibold">Portfolio Link:</span> <span className="text-muted-foreground">{formData.portfolioLink || 'N/A'}</span></div>
            <div className="text-sm"><span className="font-semibold">GitHub Link:</span> <span className="text-muted-foreground">{formData.githubLink || 'N/A'}</span></div>
            <div className="text-sm"><span className="font-semibold">Google Drive Link:</span> <span className={formData.resumeUpload ? 'text-muted-foreground break-all' : 'text-red-600 font-medium'}>{formData.resumeUpload || 'Required, not provided'}</span></div>
          </div>
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">Please review all your information carefully before submitting.</p>
    </div>
  );
}
