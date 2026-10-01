'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { collection, doc } from 'firebase/firestore';
;
import { useFirestore } from '@/firebase';
import { toast } from 'sonner';
import { Capability } from '../types';
import { addDoc, updateDoc } from '@/lib/client/firestore-wrapper';


const capabilitySchema = z.object({
  name: z.string().min(2, "Nomenclature must be at least 2 characters"),
  category: z.string().optional(),
  status: z.enum(['active', 'archived']),
  isFeatured: z.boolean().default(false),
  iconKey: z.string().optional(),
  image_url: z.string().url("Must be a valid URL").optional().or(z.literal('')),
  displayOrder: z.coerce.number().optional()
});

type CapabilityFormValues = z.infer<typeof capabilitySchema>;

interface RegisterCapabilityModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  editingSkill: Capability | null;
  onSuccess: () => void;
}

export function RegisterCapabilityModal({ isOpen, onOpenChange, editingSkill, onSuccess }: RegisterCapabilityModalProps) {
  const firestore = useFirestore();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors }
  } = useForm<CapabilityFormValues>({
    resolver: zodResolver(capabilitySchema),
    defaultValues: {
      name: '',
      category: '',
      status: 'active',
      isFeatured: false,
      iconKey: '',
      image_url: '',
      displayOrder: undefined
    }
  });

  useEffect(() => {
    if (isOpen) {
      if (editingSkill) {
        reset({
          name: editingSkill.name,
          category: editingSkill.category || '',
          status: editingSkill.status,
          isFeatured: !!editingSkill.isFeatured,
          iconKey: editingSkill.iconKey || '',
          image_url: editingSkill.image_url || '',
          displayOrder: editingSkill.displayOrder
        });
      } else {
        reset({
          name: '',
          category: '',
          status: 'active',
          isFeatured: false,
          iconKey: '',
          image_url: '',
          displayOrder: undefined
        });
      }
    }
  }, [isOpen, editingSkill, reset]);

  const onSubmit = async (data: CapabilityFormValues) => {
    setIsSubmitting(true);
    try {
      const slug = data.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const payload: Record<string, any> = {
        name: data.name.trim(),
        slug,
        category: data.category?.trim() || '',
        status: data.status,
        isFeatured: data.isFeatured,
        iconKey: data.iconKey || null,
        image_url: data.image_url || null,
        displayOrder: typeof data.displayOrder === 'number' ? data.displayOrder : null
      };

      if (editingSkill) {
        await updateDoc(doc(firestore, 'skills', editingSkill.id), payload);
        toast.success('Capability parameters updated successfully.');
      } else {
        await addDoc(collection(firestore, 'skills'), payload);
        toast.success('New capability registered to the matrix.');
      }
      
      onSuccess();
      onOpenChange(false);
    } catch (error) {
      console.error("Form submission error", error);
      toast.error('Failed to commit changes to the matrix.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const currentStatus = watch('status');
  const currentFeatured = watch('isFeatured');

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-2xl font-black uppercase tracking-tight">
            {editingSkill ? 'Reconfigure Capability' : 'Register Capability'}
          </DialogTitle>
          <DialogDescription>Define parameters for organizational skills.</DialogDescription>
        </DialogHeader>
        
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2 col-span-2">
              <Label className="text-xs font-bold uppercase text-muted-foreground">Nomenclature</Label>
              <Input 
                {...register('name')} 
                placeholder="e.g., Advanced React Patterns" 
                className={`font-bold ${errors.name ? 'border-destructive' : ''}`} 
              />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs font-bold uppercase text-muted-foreground">Category</Label>
              <Input 
                {...register('category')} 
                placeholder="e.g., Engineering" 
              />
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs font-bold uppercase text-muted-foreground">Status</Label>
              <Select value={currentStatus} onValueChange={(v: 'active' | 'archived') => setValue('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="p-3 bg-muted/30 rounded-lg border border-border/50 flex items-center justify-between">
            <div>
              <Label className="text-sm font-bold cursor-pointer" htmlFor="isFeaturedToggle">Featured Capability</Label>
              <p className="text-xs text-muted-foreground">Highlight this skill on public profiles.</p>
            </div>
            <input 
              id="isFeaturedToggle"
              type="checkbox" 
              checked={currentFeatured} 
              onChange={e => setValue('isFeatured', e.target.checked)} 
              className="h-5 w-5 accent-primary" 
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-xs font-bold uppercase text-muted-foreground">Iconography (Key)</Label>
              <Input 
                {...register('iconKey')} 
                placeholder="lucide-icon-name" 
                className="font-mono text-xs" 
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-bold uppercase text-muted-foreground">Sort Weight</Label>
              <Input 
                type="number" 
                {...register('displayOrder')} 
                placeholder="0" 
              />
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Abort
            </Button>
            <Button type="submit" className="font-bold" disabled={isSubmitting}>
              {isSubmitting ? (
                <div className="flex items-center gap-2">
                  <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                  Transmitting...
                </div>
              ) : (
                editingSkill ? 'Commit Changes' : 'Initialize'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}