"use client";

import { useFormContext, Controller } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TagInput } from '@/components/ui/tag-input';

export default function Step2Skills({ fields = [] }: { fields?: any[] }) {
  const { register, control, formState: { errors } } = useFormContext();

  return (
    <div className="space-y-4">
      {fields.length === 0 ? (
        <div className="text-muted-foreground italic text-sm text-center">Loading fields...</div>
      ) : (
        fields.map((field) => (
          <div key={field.id} className="bg-card/50 p-4 rounded-lg border border-border/50 shadow-sm">
            <Label htmlFor={field.name} className="text-base font-semibold">
              {field.label} {field.required && <span className="text-red-500">*</span>}
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

            {field.name === 'skills' || field.name === 'interestAreas' ? (
              <div className={field.description ? '' : 'mt-2'}>
                <Controller
                  control={control}
                  name={field.name}
                  render={({ field: { value, onChange } }) => (
                    <TagInput
                      value={value}
                      onChange={onChange}
                      placeholder={`Type a ${field.label.toLowerCase().replace(' (comma-separated)', '')} and press Enter`}
                    />
                  )}
                />
              </div>
            ) : (
              <Input
                id={field.name}
                {...register(field.name)}
                placeholder={`e.g., relevant ${field.label.toLowerCase()}`}
                className={field.description ? '' : 'mt-2'}
              />
            )}
            {errors[field.name] && <p className="text-red-500 text-sm mt-1">{errors[field.name]?.message?.toString()}</p>}
          </div>
        ))
      )}
    </div>
  );
}
