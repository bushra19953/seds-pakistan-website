"use client";

import { useState, useEffect } from "react";
import { getFirestore, doc, getDoc, serverTimestamp } from 'firebase/firestore';
;
import { getFirebaseApp } from "@/firebase/provider";
import { useUser } from "@/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Trash2, Plus, Settings, ChevronUp, ChevronDown, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setDoc } from '@/lib/client/firestore-wrapper';
import { logAuditEntry } from "@/lib/audit-logging";


export interface CustomField {
    id: string;
    name: string;
    label: string;
    description?: string;
    type: string;
    required: boolean;
    step: number;
    order?: number;
}

export default function InductionFormEditor() {
    const [isOpen, setIsOpen] = useState(false);
    const [fields, setFields] = useState<CustomField[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const { toast } = useToast();
    const { user } = useUser();
    const db = getFirestore(getFirebaseApp());

    // Default fields to seed if empty
    const defaultFields: CustomField[] = [
        { id: "fullName", name: "fullName", label: "Full Name", type: "text", required: true, step: 0, order: 0 },
        { id: "university", name: "university", label: "University", type: "text", required: true, step: 0, order: 1 },
        { id: "department", name: "department", label: "Department", type: "text", required: true, step: 0, order: 2 },
        { id: "studyYear", name: "studyYear", label: "Study Year", type: "text", required: true, step: 0, order: 3 },
        { id: "skills", name: "skills", label: "Skills (comma-separated)", type: "text", required: false, step: 1, order: 0 },
        { id: "interestAreas", name: "interestAreas", label: "Interest Areas (comma-separated)", type: "text", required: false, step: 1, order: 1 },
        { id: "availability", name: "availability", label: "Availability", type: "text", required: false, step: 1, order: 2 },
    ];

    useEffect(() => {
        if (isOpen) {
            loadFields();
        }
    }, [isOpen]);

    const loadFields = async () => {
        setIsLoading(true);
        try {
            const docRef = doc(db, "settings", "induction_form");
            const docSnap = await getDoc(docRef);
            if (docSnap.exists() && docSnap.data().fields) {
                // Ensure all fields have an order
                const loadedFields = (docSnap.data().fields as CustomField[]).map((f, i) => ({
                    ...f,
                    order: typeof f.order === 'number' ? f.order : i
                }));
                setFields(loadedFields);
            } else {
                setFields(defaultFields);
            }
        } catch (error) {
            console.error("Error loading fields:", error);
            toast({ title: "Error", description: "Failed to load form configuration.", variant: "destructive" });
        } finally {
            setIsLoading(false);
        }
    };

    // Field names reserved by the hardcoded induction page schema. Dynamic
    // fields using these names would silently overwrite the built-in
    // resume/link validation, so they are rejected on save.
    const RESERVED_FIELD_NAMES = ["resumeUpload", "portfolioLink", "githubLink"];

    // Validate the field configuration before saving. Returns an error
    // message for the first problem found, or null when valid.
    const validateFields = (): string | null => {
        const seen = new Set<string>();
        for (const field of fields) {
            const name = (field.name || "").trim();
            const label = (field.label || "").trim();
            if (!name) {
                return "Every field needs an internal name (data key). One field is missing it.";
            }
            if (!label) {
                return `Field "${name}" is missing a label. Every field needs a prompt shown to applicants.`;
            }
            if (RESERVED_FIELD_NAMES.includes(name)) {
                return `Field name "${name}" is reserved. It is used by the hardcoded resume and link fields in the induction page and would silently overwrite their validation. Pick a different data key.`;
            }
            if (seen.has(name)) {
                return `Duplicate field name "${name}". Internal names must be unique across all fields.`;
            }
            seen.add(name);
            if (!Number.isInteger(field.step) || field.step < 0 || field.step > 4) {
                return `Field "${name}" has an invalid step. Step must be a whole number from 1 to 5.`;
            }
        }
        return null;
    };

    const saveFields = async () => {
        const validationError = validateFields();
        if (validationError) {
            toast({ title: "Invalid configuration", description: validationError, variant: "destructive" });
            return;
        }
        setIsLoading(true);
        try {
            await setDoc(doc(db, "settings", "induction_form"), {
                fields,
                updatedAt: serverTimestamp(),
                updatedBy: user?.uid || null,
            });
            await logAuditEntry(db, 'induction_form_updated', user?.uid || 'unknown', 'settings/induction_form', {
                fieldCount: fields.length,
            });
            toast({ title: "Success", description: "Form fields updated successfully." });
            setIsOpen(false);
        } catch (error) {
            console.error("Error saving fields:", error);
            toast({ title: "Error", description: "Failed to save form configuration.", variant: "destructive" });
        } finally {
            setIsLoading(false);
        }
    };

    const addField = (step: number = 0) => {
        const stepFields = fields.filter(f => f.step === step);
        const maxOrder = stepFields.length > 0 ? Math.max(...stepFields.map(f => f.order || 0)) : -1;

        const newField: CustomField = {
            id: `field_${Date.now()}`,
            name: `custom_${Date.now()}`,
            label: "New Custom Field",
            description: "",
            type: "text",
            required: false,
            step: step,
            order: maxOrder + 1
        };
        setFields([...fields, newField]);
    };

    const updateField = (id: string, key: keyof CustomField, value: any) => {
        setFields(fields.map(f => f.id === id ? { ...f, [key]: value } : f));
    };

    const removeField = (id: string) => {
        setFields(fields.filter(f => f.id !== id));
    };

    const moveField = (id: string, direction: 'up' | 'down') => {
        const fieldIndex = fields.findIndex(f => f.id === id);
        if (fieldIndex === -1) return;

        const field = fields[fieldIndex];
        const stepFields = fields
            .filter(f => f.step === field.step)
            .sort((a, b) => (a.order || 0) - (b.order || 0));

        const internalIndex = stepFields.findIndex(f => f.id === id);

        if (direction === 'up' && internalIndex > 0) {
            const prevField = stepFields[internalIndex - 1];
            const tempOrder = field.order;
            field.order = prevField.order;
            prevField.order = tempOrder;
        } else if (direction === 'down' && internalIndex < stepFields.length - 1) {
            const nextField = stepFields[internalIndex + 1];
            const tempOrder = field.order;
            field.order = nextField.order;
            nextField.order = tempOrder;
        }

        setFields([...fields]);
    };

    const steps = [0, 1, 2, 3, 4];
    const stepNames: Record<number, string> = {
        0: "Personal Information",
        1: "Skills & Interests",
        2: "Assessments & Links",
        3: "Technical Questions",
        4: "Additional Info"
    };

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                <Button variant="outline" className="mb-4">
                    <Settings className="w-4 h-4 mr-2" />
                    Configure Application Form
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-0 bg-background border-border">
                <div className="p-6 border-b border-border bg-card/50">
                    <DialogTitle className="text-2xl font-bold text-foreground mb-2">Induction Form Editor</DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                        Design the induction flow. Group fields into steps and reorder them for a smooth applicant experience.
                    </DialogDescription>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-8 bg-background/80">
                    {isLoading ? (
                        <div className="flex justify-center p-8 text-primary"><Loader2 className="w-8 h-8 animate-spin" /></div>
                    ) : (
                        <>
                            {steps.map(stepNum => {
                                const stepFields = fields
                                    .filter(f => f.step === stepNum)
                                    .sort((a, b) => (a.order || 0) - (b.order || 0));

                                return (
                                    <div key={stepNum} className="space-y-4">
                                        <div className="flex items-center justify-between bg-card/80 p-3 rounded-t-lg border-l-4 border-l-primary px-4">
                                            <h3 className="font-bold text-lg text-foreground">Step {stepNum + 1}: {stepNames[stepNum]}</h3>
                                            <Button variant="ghost" size="sm" className="text-primary hover:text-foreground hover:bg-primary/20" onClick={() => addField(stepNum)}>
                                                <Plus className="w-4 h-4 mr-1" /> Add to this Step
                                            </Button>
                                        </div>

                                        <div className="space-y-3 min-h-[50px]">
                                            {stepFields.length === 0 ? (
                                                <div className="text-muted-foreground italic text-sm p-4 border border-dashed border-border rounded-b-lg text-center">
                                                    No fields in this step.
                                                </div>
                                            ) : (
                                                stepFields.map((field, idx) => (
                                                    <Card key={field.id} className="p-4 bg-card/40 border-border hover:border-muted-foreground transition-colors shadow-none">
                                                        <div className="flex items-start gap-4">
                                                            <div className="flex flex-col gap-1 mt-6">
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                                                    disabled={idx === 0}
                                                                    onClick={() => moveField(field.id, 'up')}
                                                                >
                                                                    <ChevronUp className="w-4 h-4" />
                                                                </Button>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                                                                    disabled={idx === stepFields.length - 1}
                                                                    onClick={() => moveField(field.id, 'down')}
                                                                >
                                                                    <ChevronDown className="w-4 h-4" />
                                                                </Button>
                                                            </div>

                                                            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                                                                <div>
                                                                    <Label className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider">Field Label / Prompt</Label>
                                                                    <Input
                                                                        className="bg-background/80 border-input"
                                                                        value={field.label}
                                                                        onChange={(e) => updateField(field.id, 'label', e.target.value)}
                                                                    />
                                                                </div>
                                                                <div>
                                                                    <Label className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider">Internal Name (Data Key)</Label>
                                                                    <Input
                                                                        className="bg-background/80 border-input font-mono text-xs"
                                                                        value={field.name}
                                                                        onChange={(e) => updateField(field.id, 'name', e.target.value)}
                                                                    />
                                                                </div>
                                                                <div className="md:col-span-2">
                                                                    <Label className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider">Instructions / Assessment Link (Optional)</Label>
                                                                    <Input
                                                                        className="bg-background/80 border-input"
                                                                        value={field.description || ''}
                                                                        placeholder="e.g. Please complete the test at https://hackerrank.com before answering."
                                                                        onChange={(e) => updateField(field.id, 'description', e.target.value)}
                                                                    />
                                                                </div>
                                                                <div>
                                                                    <Label className="text-[10px] uppercase text-muted-foreground font-bold tracking-wider">Move to Step</Label>
                                                                    <Select
                                                                        value={field.step.toString()}
                                                                        onValueChange={(val) => updateField(field.id, 'step', parseInt(val))}
                                                                    >
                                                                        <SelectTrigger className="bg-background/80 border-input">
                                                                            <SelectValue />
                                                                        </SelectTrigger>
                                                                        <SelectContent className="bg-popover border-border">
                                                                            {Object.entries(stepNames).map(([val, name]) => (
                                                                                <SelectItem key={val} value={val}>Step {parseInt(val) + 1}: {name}</SelectItem>
                                                                            ))}
                                                                        </SelectContent>
                                                                    </Select>
                                                                </div>
                                                                <div className="flex items-center space-x-2 pt-6">
                                                                    <input
                                                                        type="checkbox"
                                                                        id={`req_${field.id}`}
                                                                        checked={field.required}
                                                                        onChange={(e) => updateField(field.id, 'required', e.target.checked)}
                                                                        className="rounded border-input bg-background text-primary"
                                                                    />
                                                                    <Label htmlFor={`req_${field.id}`} className="text-sm cursor-pointer text-muted-foreground">Required Field?</Label>
                                                                </div>
                                                            </div>

                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="text-red-900 hover:text-red-500 hover:bg-red-500/10 self-start mt-4"
                                                                onClick={() => removeField(field.id)}
                                                            >
                                                                <Trash2 className="w-4 h-4" />
                                                            </Button>
                                                        </div>
                                                    </Card>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </>
                    )}
                </div>

                <div className="p-6 border-t border-border bg-card/50 flex justify-between items-center">
                    <div className="text-xs text-muted-foreground">
                        Total Fields: {fields.length}
                    </div>
                    <div className="flex gap-4">
                        <Button variant="ghost" onClick={() => setIsOpen(false)} className="text-muted-foreground hover:text-foreground">
                            Cancel
                        </Button>
                        <Button onClick={saveFields} disabled={isLoading} className="bg-primary hover:bg-primary/90 text-foreground px-8">
                            Save Configuration
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

