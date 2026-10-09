"use client";

import { useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import UniversityAutocomplete from './UniversityAutocomplete';

// Assume fields for step 0 (Personal) are passed in
export default function Step1Personal({ fields = [] }: { fields?: any[] }) {
  const { register, formState: { errors } } = useFormContext();

  return (
    <div className="space-y-4">
      {fields.length === 0 ? (
        <div className="text-muted-foreground italic text-sm text-center">Loading fields...</div>
      ) : (
        fields.map((field) => (
          <div key={field.id} className="bg-card/50 p-4 rounded-lg border border-border/50 shadow-sm">
            <Label htmlFor={field.name} className="text-base font-semibold">
              {field.label}{' '}
              {field.required && <span className="text-red-500" aria-hidden="true">*</span>}
              {field.required && <span className="sr-only">(required)</span>}
            </Label>

            {field.description && (
              <p className="text-sm text-muted-foreground mt-1 mb-3">
                {field.description.includes('http') ? (
                  <>
                    {field.description.split(/(https?:\/\/[^\s]+)/g).map((part: string, i: number) =>
                      part.match(/https?:\/\/[^\s]+/) ? (
                        <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                          {part}
                        </a>
                      ) : (
                        <span key={i}>{part}</span>
                      )
                    )}
                  </>
                ) : (
                  field.description
                )}
              </p>
            )}

            {field.name === 'university' ? (
              <UniversityAutocomplete name={field.name} placeholder={field.label} />
            ) : field.type === 'select' && Array.isArray(field.options) ? (
              <select
                id={field.name}
                {...register(field.name)}
                className={field.description ? 'mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm' : 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm'}
                aria-describedby={`err-${field.name}`}
                aria-invalid={!!errors[field.name]}
                aria-required={field.required ? 'true' : undefined}
                defaultValue=""
              >
                <option value="">Select {field.label} (optional)</option>
                {field.options.map((opt: any) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={field.name}
                {...register(field.name)}
                placeholder={field.label}
                className={field.description ? '' : 'mt-2'}
                aria-describedby={`err-${field.name}`}
                aria-invalid={!!errors[field.name]}
                aria-required={field.required ? 'true' : undefined}
              />
            )}
            {errors[field.name] && (
              <p id={`err-${field.name}`} className="text-red-600 text-sm mt-1">
                {errors[field.name]?.message?.toString()}
              </p>
            )}
          </div>
        ))
      )}
    </div>
  );
}
