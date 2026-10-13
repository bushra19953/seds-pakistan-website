"use client";

import { useState } from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { TagInput } from '@/components/ui/tag-input';

interface SkillsFallbackInputProps {
  name: string;
  placeholder: string;
}

// M4: plain-text escape hatch for the tag inputs. If every tag-commit trigger
// (Enter key, add button, paste split, IME go/done) fails on some exotic
// keyboard, the applicant is still not stuck: they flip this toggle and type
// a plain comma-separated string instead. The zod schema in
// src/app/induction/page.tsx accepts z.string() for skills/interestAreas and
// its transform comma-splits it, so the string path is validation-safe.
export default function SkillsFallbackInput({ name, placeholder }: SkillsFallbackInputProps) {
  const { control } = useFormContext();
  const [usePlainText, setUsePlainText] = useState(false);

  const toArray = (value: any): string[] =>
    Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',').map((s: string) => s.trim()).filter(Boolean)
        : [];

  const toString = (value: any): string =>
    typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : '';

  return (
    <Controller
      control={control}
      name={name}
      render={({ field: { value, onChange } }) => (
        <div>
          {usePlainText ? (
            <Input
              value={toString(value)}
              onChange={(e) => onChange(e.target.value)}
              placeholder="Type items separated by commas"
              aria-label={`${name} (plain text)`}
            />
          ) : (
            <TagInput
              value={toArray(value)}
              onChange={(tags: string[]) => onChange(tags)}
              placeholder={placeholder}
            />
          )}
          <button
            type="button"
            onClick={() => setUsePlainText((prev) => !prev)}
            className="mt-1.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {usePlainText ? 'Back to tag input' : 'Having trouble adding tags? Use plain text instead'}
          </button>
        </div>
      )}
    />
  );
}
