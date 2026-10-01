
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
    options?: string[]; // For select/radio if implemented in builder
}

export interface Form {
    id: string;
    title: string;
    description: string;
    fields: FormField[];
}

interface FormRendererProps {
    form: Form;
    responses: Record<string, any>;
    onChange: (fieldId: string, value: any) => void;
}

export function FormRenderer({ form, responses, onChange }: FormRendererProps) {
    if (!form || !form.fields) return null;

    return (
        <div className="space-y-6 border rounded-lg p-6 bg-card/50">
            <div>
                <h3 className="text-lg font-semibold">{form.title}</h3>
                <p className="text-sm text-muted-foreground">{form.description}</p>
            </div>

            <div className="space-y-4">
                {form.fields.map((field) => {
                    return (
                        <div key={field.id} className="space-y-2">
                            <Label htmlFor={field.id} className="text-base">
                                {field.label} {field.required && <span className="text-red-500">*</span>}
                            </Label>

                            {field.type === 'text' && (
                                <Input
                                    id={field.id}
                                    value={responses[field.id] || ''}
                                    onChange={(e) => onChange(field.id, e.target.value)}
                                    required={field.required}
                                    placeholder={`Enter ${field.label.toLowerCase()}`}
                                />
                            )}

                            {field.type === 'email' && (
                                <Input
                                    id={field.id}
                                    type="email"
                                    value={responses[field.id] || ''}
                                    onChange={(e) => onChange(field.id, e.target.value)}
                                    required={field.required}
                                    placeholder="email@example.com"
                                />
                            )}

                            {field.type === 'number' && (
                                <Input
                                    id={field.id}
                                    type="number"
                                    value={responses[field.id] || ''}
                                    onChange={(e) => onChange(field.id, e.target.value)}
                                    required={field.required}
                                />
                            )}

                            {field.type === 'textarea' && (
                                <Textarea
                                    id={field.id}
                                    value={responses[field.id] || ''}
                                    onChange={(e) => onChange(field.id, e.target.value)}
                                    required={field.required}
                                    className="min-h-[100px]"
                                />
                            )}

                            {/* Add other field types as needed based on FormField definition */}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
