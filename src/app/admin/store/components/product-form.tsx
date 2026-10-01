
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";

interface Product {
    id: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    stock: number;
    category: string;
    eventId?: string;
    formId?: string;
    isActive: boolean;
    imageUrl?: string;
}

interface Event {
    id: string;
    title: string;
    status: string;
}

interface Form {
    id: string;
    title: string;
}

interface ProductFormProps {
    formData: Partial<Product>;
    setFormData: (data: Partial<Product>) => void;
    events: Event[];
    forms: Form[];
    onSubmit: () => void;
    onCancel: () => void;
    submitting: boolean;
    submitLabel: string;
}

const CATEGORIES = [
    "certificate",
    "merchandise",
    "workshop",
    "event_ticket",
    "digital_content",
    "other"
];

export function ProductForm({ formData, setFormData, events, forms, onSubmit, onCancel, submitting, submitLabel }: ProductFormProps) {
    const updateField = (field: keyof Product, value: any) => {
        setFormData({ ...formData, [field]: value });
    };

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Name */}
                <div className="space-y-2">
                    <Label htmlFor="name">Product Name</Label>
                    <Input
                        id="name"
                        value={formData.name || ''}
                        onChange={(e) => updateField('name', e.target.value)}
                        placeholder="e.g. Annual Conference Ticket"
                    />
                </div>

                {/* Category */}
                <div className="space-y-2">
                    <Label htmlFor="category">Category</Label>
                    <Select
                        value={formData.category || 'other'}
                        onValueChange={(value) => updateField('category', value)}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                        <SelectContent>
                            {CATEGORIES.map(category => (
                                <SelectItem key={category} value={category}>
                                    {category.replace('_', ' ').toUpperCase()}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Price */}
                <div className="space-y-2">
                    <Label htmlFor="price">Price</Label>
                    <Input
                        id="price"
                        type="number"
                        min="0"
                        step="0.01"
                        value={formData.price || 0}
                        onChange={(e) => updateField('price', parseFloat(e.target.value))}
                    />
                </div>

                {/* Currency */}
                <div className="space-y-2">
                    <Label htmlFor="currency">Currency</Label>
                    <Select
                        value={formData.currency || 'USD'}
                        onValueChange={(value) => updateField('currency', value)}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Currency" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="USD">USD ($)</SelectItem>
                            <SelectItem value="PKR">PKR (Rs)</SelectItem>
                            <SelectItem value="EUR">EUR (€)</SelectItem>
                            <SelectItem value="GBP">GBP (£)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {/* Stock */}
                <div className="space-y-2">
                    <Label htmlFor="stock">Stock</Label>
                    <Input
                        id="stock"
                        type="number"
                        min="0"
                        value={formData.stock || 0}
                        onChange={(e) => updateField('stock', parseInt(e.target.value))}
                    />
                </div>

                {/* Image URL */}
                <div className="space-y-2">
                    <Label htmlFor="imageUrl">Image URL</Label>
                    <Input
                        id="imageUrl"
                        value={formData.imageUrl || ''}
                        onChange={(e) => updateField('imageUrl', e.target.value)}
                        placeholder="https://..."
                    />
                </div>
            </div>

            {/* Description */}
            <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                    id="description"
                    value={formData.description || ''}
                    onChange={(e) => updateField('description', e.target.value)}
                    placeholder="Detailed product description..."
                    className="min-h-[100px]"
                />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t">
                {/* Linked Event */}
                <div className="space-y-2">
                    <Label htmlFor="eventId">Related Event (Optional)</Label>
                    <Select
                        value={formData.eventId || "none"}
                        onValueChange={(value) => updateField('eventId', value === "none" ? undefined : value)}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Link to an event..." />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {events.map(event => (
                                <SelectItem key={event.id} value={event.id}>
                                    {event.title}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Example: Buying this ticket grants access to the selected event.</p>
                </div>

                {/* Linked Form */}
                <div className="space-y-2">
                    <Label htmlFor="formId">Additional Questions (Optional)</Label>
                    <Select
                        value={formData.formId || "none"}
                        onValueChange={(value) => updateField('formId', value === "none" ? undefined : value)}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Ask custom questions..." />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {forms.map(form => (
                                <SelectItem key={form.id} value={form.id}>
                                    {form.title}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Select a form to collect extra info during checkout (e.g. T-Shirt Size, Chapter Name).</p>
                </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-4">
                <Button variant="outline" onClick={onCancel}>Cancel</Button>
                <Button onClick={onSubmit} disabled={submitting}>
                    {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {submitLabel}
                </Button>
            </div>
        </div>
    );
}
