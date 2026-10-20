"use client";

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Check, Loader2 } from 'lucide-react';
import { DOMAIN_PREFERENCES, sanitizeDomainPreferences } from '@/lib/applicant-status';

interface DomainPreferencesSectionProps {
  domainPreferences: string[];
  canEdit: boolean;
  saving: boolean;
  saveError: string | null;
  onSave: (preferences: string[]) => Promise<void>;
}

export default function DomainPreferencesSection({
  domainPreferences,
  canEdit,
  saving,
  saveError,
  onSave,
}: DomainPreferencesSectionProps) {
  const [selected, setSelected] = useState<string[]>(() => sanitizeDomainPreferences(domainPreferences));

  const toggle = (value: string) => {
    setSelected((prev) => sanitizeDomainPreferences(
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    ));
  };

  if (!canEdit && selected.length === 0) return null;

  return (
    <Card className="border-primary/20">
      <CardHeader>
        <CardTitle>Domain preferences</CardTitle>
        <CardDescription>
          {canEdit
            ? 'Pick the teams you want to join. You can change this any time.'
            : 'The teams this applicant is interested in.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {DOMAIN_PREFERENCES.map((option) => {
            const checked = selected.includes(option.value);
            const inputId = `domain-${option.value}`;
            return (
              <div
                key={option.value}
                className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                  checked ? 'border-primary/50 bg-primary/10' : 'border-border bg-muted/30'
                }`}
              >
                {canEdit ? (
                  <>
                    <Checkbox
                      id={inputId}
                      checked={checked}
                      onCheckedChange={() => toggle(option.value)}
                    />
                    <Label htmlFor={inputId} className="cursor-pointer font-medium text-foreground">
                      {option.label}
                    </Label>
                  </>
                ) : (
                  <span className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className={`flex h-5 w-5 items-center justify-center rounded border ${
                        checked ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border bg-muted/40'
                      }`}
                    >
                      {checked ? <Check className="h-3.5 w-3.5" /> : null}
                    </span>
                    <span className="font-medium text-foreground">{option.label}</span>
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {canEdit && (
          <div className="space-y-2">
            {saveError && (
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            )}
            <Button onClick={() => onSave(selected)} disabled={saving}>
              {saving ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving...
                </span>
              ) : (
                'Save preferences'
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
