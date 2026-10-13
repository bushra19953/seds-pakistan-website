import React from 'react';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface FormField {
    id: string;
    label: string;
    type: string;
    required: boolean;
    options?: string[]; // For select/radio/checkbox groups
}

export interface Form {
    id: string;
    title: string;
    description: string;
    fields: FormField[];
}

/**
 * Field-level error messages keyed by field id.
 * Parents compute these with validateFormResponses() on submit and pass them
 * back in so every problem is shown next to the field it belongs to.
 */
export type FormErrors = Record<string, string>;

interface FormRendererProps {
    form: Form;
    responses: Record<string, any>;
    onChange: (fieldId: string, value: any) => void;
    /**
     * Per-field error messages (e.g. from validateFormResponses, or server-side
     * field errors). Always pass these through so errors are never swallowed.
     */
    errors?: FormErrors;
    /**
     * A form-wide error message (e.g. a failed server response on submit).
     * Rendered as a visible banner above the fields.
     */
    formError?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Allows +, digits, spaces, dashes, parentheses. Requires at least 6 digits.
const PHONE_RE = /^[+()\-.\s]*\d[+()\-.\s\d]*$/;

function isBlank(value: any): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
}

function labelLower(label: string): string {
    return label.trim().toLowerCase();
}

/**
 * Validate every field and return a plain-language error per failing field,
 * keyed by field id. Returns an empty object when everything is valid.
 *
 * Call this on submit and block submission while the result is non-empty.
 * Never submit while errors exist, and always pass the result back into the
 * FormRenderer `errors` prop so the user sees what to fix.
 */
export function validateFormResponses(form: Form, responses: Record<string, any>): FormErrors {
    const errors: FormErrors = {};
    if (!form || !form.fields) return errors;

    for (const field of form.fields) {
        const value = responses[field.id];
        const name = labelLower(field.label);

        if (field.required && (isBlank(value) || (field.type === 'checkbox' && value !== true))) {
            switch (field.type) {
                case 'email':
                    errors[field.id] = 'Please enter your email address.';
                    break;
                case 'number':
                    errors[field.id] = `Please enter a number for ${name}.`;
                    break;
                case 'tel':
                case 'phone':
                    errors[field.id] = 'Please enter your phone number.';
                    break;
                case 'select':
                    errors[field.id] = `Please choose an option for ${name}.`;
                    break;
                case 'radio':
                case 'checkbox-group':
                    errors[field.id] = `Please select an option for ${name}.`;
                    break;
                case 'checkbox':
                    errors[field.id] = `Please check the box for ${name} to continue.`;
                    break;
                case 'date':
                    errors[field.id] = `Please pick a date for ${name}.`;
                    break;
                default:
                    errors[field.id] = `Please enter your ${name}.`;
                    break;
            }
            continue;
        }

        if (isBlank(value)) continue;

        // Format checks for filled-in optional fields too.
        switch (field.type) {
            case 'email':
                if (!EMAIL_RE.test(String(value).trim())) {
                    errors[field.id] = "That email address doesn't look right. Please check it and try again.";
                }
                break;
            case 'number':
                if (Number.isNaN(Number(value))) {
                    errors[field.id] = `Please enter a number for ${name}.`;
                }
                break;
            case 'tel':
            case 'phone': {
                const digits = String(value).replace(/\D/g, '');
                if (!PHONE_RE.test(String(value)) || digits.length < 6) {
                    errors[field.id] = "That phone number doesn't look right. Use digits, spaces, + or -.";
                }
                break;
            }
            case 'date':
                if (Number.isNaN(Date.parse(String(value)))) {
                    errors[field.id] = "That date isn't valid. Please pick a real date.";
                }
                break;
            default:
                break;
        }
    }

    return errors;
}

function FieldError({ id, message }: { id: string; message: string }) {
    return (
        <p id={`${id}-error`} role="alert" className="text-sm text-red-500">
            {message}
        </p>
    );
}

function inputClassName(hasError: boolean, extra?: string) {
    return `${hasError ? 'border-red-500 focus-visible:ring-red-500' : ''}${extra ? ` ${extra}` : ''}`;
}

export function FormRenderer({ form, responses, onChange, errors = {}, formError = null }: FormRendererProps) {
    if (!form || !form.fields) return null;

    const renderInput = (field: FormField) => {
        const value = responses[field.id];
        const error = errors[field.id];
        const hasError = Boolean(error);
        const describedBy = hasError ? `${field.id}-error` : undefined;
        const stringValue = value === null || value === undefined ? '' : String(value);

        switch (field.type) {
            case 'text':
            case 'tel':
            case 'phone':
                return (
                    <Input
                        id={field.id}
                        type={field.type === 'text' ? 'text' : 'tel'}
                        value={stringValue}
                        onChange={(e) => onChange(field.id, e.target.value)}
                        required={field.required}
                        aria-invalid={hasError}
                        aria-describedby={describedBy}
                        className={inputClassName(hasError)}
                        placeholder={field.type === 'text' ? `Enter ${labelLower(field.label)}` : '+92 300 1234567'}
                    />
                );
            case 'email':
                return (
                    <Input
                        id={field.id}
                        type="email"
                        value={stringValue}
                        onChange={(e) => onChange(field.id, e.target.value)}
                        required={field.required}
                        aria-invalid={hasError}
                        aria-describedby={describedBy}
                        className={inputClassName(hasError)}
                        placeholder="email@example.com"
                    />
                );
            case 'number':
                return (
                    <Input
                        id={field.id}
                        type="number"
                        value={stringValue}
                        onChange={(e) => onChange(field.id, e.target.value)}
                        required={field.required}
                        aria-invalid={hasError}
                        aria-describedby={describedBy}
                        className={inputClassName(hasError)}
                    />
                );
            case 'date':
                return (
                    <Input
                        id={field.id}
                        type="date"
                        value={stringValue}
                        onChange={(e) => onChange(field.id, e.target.value)}
                        required={field.required}
                        aria-invalid={hasError}
                        aria-describedby={describedBy}
                        className={inputClassName(hasError)}
                    />
                );
            case 'textarea':
                return (
                    <Textarea
                        id={field.id}
                        value={stringValue}
                        onChange={(e) => onChange(field.id, e.target.value)}
                        required={field.required}
                        aria-invalid={hasError}
                        aria-describedby={describedBy}
                        className={`min-h-[100px] ${inputClassName(hasError)}`}
                    />
                );
            case 'select':
                return (
                    <Select
                        value={stringValue || undefined}
                        onValueChange={(v) => onChange(field.id, v)}
                        required={field.required}
                    >
                        <SelectTrigger
                            id={field.id}
                            aria-invalid={hasError}
                            aria-describedby={describedBy}
                            className={inputClassName(hasError)}
                        >
                            <SelectValue placeholder={`Choose ${labelLower(field.label)}`} />
                        </SelectTrigger>
                        <SelectContent>
                            {(field.options || []).map((opt) => (
                                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                );
            case 'radio':
                return (
                    <RadioGroup
                        value={stringValue}
                        onValueChange={(v) => onChange(field.id, v)}
                        aria-invalid={hasError}
                        aria-describedby={describedBy}
                        className="space-y-2"
                    >
                        {(field.options || []).map((opt) => (
                            <div key={opt} className="flex items-center space-x-2">
                                <RadioGroupItem value={opt} id={`${field.id}-${opt}`} />
                                <Label htmlFor={`${field.id}-${opt}`}>{opt}</Label>
                            </div>
                        ))}
                    </RadioGroup>
                );
            case 'checkbox': {
                // Single checkbox (e.g. "I agree"). Use checkbox-group for multi-select.
                const checked = value === true;
                return (
                    <div className="flex items-center space-x-2">
                        <Checkbox
                            id={field.id}
                            checked={checked}
                            onCheckedChange={(c) => onChange(field.id, c === true)}
                            required={field.required}
                            aria-invalid={hasError}
                            aria-describedby={describedBy}
                        />
                        <Label htmlFor={field.id} className="text-sm font-normal">{field.label}</Label>
                    </div>
                );
            }
            case 'checkbox-group': {
                const selected: string[] = Array.isArray(value) ? value : [];
                const toggle = (opt: string) => {
                    onChange(
                        field.id,
                        selected.includes(opt) ? selected.filter((s) => s !== opt) : [...selected, opt]
                    );
                };
                return (
                    <div className="space-y-2" aria-invalid={hasError} aria-describedby={describedBy}>
                        {(field.options || []).map((opt) => (
                            <div key={opt} className="flex items-center space-x-2">
                                <Checkbox
                                    id={`${field.id}-${opt}`}
                                    checked={selected.includes(opt)}
                                    onCheckedChange={() => toggle(opt)}
                                />
                                <Label htmlFor={`${field.id}-${opt}`} className="text-sm font-normal">{opt}</Label>
                            </div>
                        ))}
                    </div>
                );
            }
            default:
                // Unknown field type: fall back to a plain text input so the
                // field stays answerable instead of silently rendering nothing.
                return (
                    <Input
                        id={field.id}
                        value={stringValue}
                        onChange={(e) => onChange(field.id, e.target.value)}
                        required={field.required}
                        aria-invalid={hasError}
                        aria-describedby={describedBy}
                        className={inputClassName(hasError)}
                        placeholder={`Enter ${labelLower(field.label)}`}
                    />
                );
        }
    };

    return (
        <div className="space-y-6 border rounded-lg p-6 bg-card/50">
            <div>
                <h3 className="text-lg font-semibold">{form.title}</h3>
                <p className="text-sm text-muted-foreground">{form.description}</p>
            </div>

            {formError && (
                <div role="alert" className="rounded-md border border-red-500/50 bg-red-500/10 p-4">
                    <p className="text-sm font-semibold text-red-500">Something went wrong</p>
                    <p className="text-sm text-red-400 mt-1">{formError}</p>
                </div>
            )}

            <div className="space-y-4">
                {form.fields.map((field) => {
                    const error = errors[field.id];
                    // Single checkboxes render their own label next to the box.
                    const showLabel = field.type !== 'checkbox';
                    return (
                        <div key={field.id} className="space-y-2">
                            {showLabel && (
                                <Label htmlFor={field.id} className="text-base">
                                    {field.label} {field.required && <span className="text-red-500">*</span>}
                                </Label>
                            )}
                            {renderInput(field)}
                            {error && <FieldError id={field.id} message={error} />}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
