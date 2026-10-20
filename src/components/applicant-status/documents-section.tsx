"use client";

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ExternalLink, Loader2 } from 'lucide-react';
import type { ApplicantDocuments } from '@/lib/applicant-status';

interface DocumentsSectionProps {
  documents: ApplicantDocuments;
  canEdit: boolean;
  saving: boolean;
  saveError: string | null;
  onSave: (documents: {
    resumeUrl: string;
    transcriptUrl: string;
    portfolioLink: string;
    githubLink: string;
  }) => Promise<void>;
}

type DocumentKey = 'resumeUrl' | 'transcriptUrl' | 'portfolioLink' | 'githubLink';

const FIELDS: Array<{
  key: DocumentKey;
  label: string;
  hint: string;
  placeholder: string;
}> = [
  {
    key: 'resumeUrl',
    label: 'Resume',
    hint: 'Upload to Google Drive with Anyone with the link sharing, then paste the link.',
    placeholder: 'https://drive.google.com/file/d/...',
  },
  {
    key: 'transcriptUrl',
    label: 'Transcript',
    hint: 'Upload to Google Drive with Anyone with the link sharing, then paste the link.',
    placeholder: 'https://drive.google.com/file/d/...',
  },
  {
    key: 'portfolioLink',
    label: 'Portfolio',
    hint: 'Your portfolio or personal website.',
    placeholder: 'https://your-portfolio.com',
  },
  {
    key: 'githubLink',
    label: 'GitHub',
    hint: 'Link to your GitHub profile.',
    placeholder: 'https://github.com/your-profile',
  },
];

function linkValue(documents: ApplicantDocuments, key: DocumentKey): string {
  return (
    (key === 'resumeUrl' ? documents.resumeUrl
      : key === 'transcriptUrl' ? documents.transcriptUrl
      : key === 'portfolioLink' ? documents.portfolioLink
      : documents.githubLink) ?? ''
  );
}

export default function DocumentsSection({ documents, canEdit, saving, saveError, onSave }: DocumentsSectionProps) {
  const [values, setValues] = useState({
    resumeUrl: linkValue(documents, 'resumeUrl'),
    transcriptUrl: linkValue(documents, 'transcriptUrl'),
    portfolioLink: linkValue(documents, 'portfolioLink'),
    githubLink: linkValue(documents, 'githubLink'),
  });
  const [dirty, setDirty] = useState(false);

  const update = (key: keyof typeof values, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  return (
    <Card className="border-primary/20">
      <CardHeader>
        <CardTitle>Documents and links</CardTitle>
        <CardDescription>
          Your resume, transcript, and portfolio links stay with your application.
          {canEdit ? ' You can update them any time while your application is active.' : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {FIELDS.map((field) => {
          const value = values[field.key];
          return (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`doc-${field.key}`}>{field.label}</Label>
              <div className="flex items-start gap-2">
                {canEdit ? (
                  <Input
                    id={`doc-${field.key}`}
                    value={value}
                    onChange={(e) => update(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    inputMode="url"
                  />
                ) : value ? (
                  <a
                    href={value}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 break-all text-sm text-blue-400 hover:text-blue-300 hover:underline"
                  >
                    {value} <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  </a>
                ) : (
                  <span className="text-sm text-muted-foreground">Not provided yet.</span>
                )}
              </div>
              {canEdit && <p className="text-xs text-muted-foreground">{field.hint}</p>}
            </div>
          );
        })}
        {canEdit && (
          <div className="space-y-2">
            {saveError && (
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            )}
            <Button
              onClick={async () => {
                await onSave(values);
                setDirty(false);
              }}
              disabled={saving || !dirty}
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving...
                </span>
              ) : (
                'Save documents'
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
