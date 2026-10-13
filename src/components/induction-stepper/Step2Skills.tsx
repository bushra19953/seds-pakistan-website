"use client";

import { useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import SkillsFallbackInput from './SkillsFallbackInput';
import ExternalAssessmentCard, { hasExternalAssessmentLink } from './ExternalAssessmentCard';

// Exact text of the cross-field "skills OR interestAreas" validation message.
// The schema's superRefine attaches this issue to path ['skills'], so it is
// mirrored under the interestAreas field here as well.
const SKILLS_OR_INTERESTS_ERROR_MESSAGE = 'Add at least one skill or interest area';

export default function Step2Skills({ fields = [] }: { fields?: any[] }) {
  const { register, formState: { errors } } = useFormContext();

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
              hasExternalAssessmentLink(field) ? (
                <ExternalAssessmentCard field={field} />
              ) : (
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
              )
            )}

            {field.name === 'skills' || field.name === 'interestAreas' ? (
              <div className={field.description ? '' : 'mt-2'}>
                <SkillsFallbackInput
                  name={field.name}
                  placeholder={`Add ${field.label.toLowerCase().replace(' (comma-separated)', '')} and press Enter`}
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
            {errors[field.name] && <p className="text-red-600 text-sm mt-1">{errors[field.name]?.message?.toString()}</p>}
            {field.name === 'interestAreas' && errors.skills?.message?.toString() === SKILLS_OR_INTERESTS_ERROR_MESSAGE && (
              <p className="text-red-600 text-sm mt-1">{SKILLS_OR_INTERESTS_ERROR_MESSAGE}</p>
            )}
          </div>
        ))
      )}
    </div>
  );
}
