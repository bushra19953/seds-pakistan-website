'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useRouter } from 'next/navigation';
import { useCollection, useUser } from '@/firebase';
import { isPresident } from '@/lib/roles';
import { addProjectClient } from '@/lib/client-actions';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, PlusCircle } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MultiSelect } from '@/components/ui/multi-select';
import { useMemoFirebase } from '@/lib/use-memo-firebase';
import { collection } from 'firebase/firestore';
import { useFirestore } from '@/firebase/provider';

// Slug helper
function slugify(input: string) {
  return (input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

const projectSchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters.'),
  slug: z.string().min(3, 'Slug must be at least 3 characters.'),
  description: z.string().min(10, 'Description must be at least 10 characters.'),
  imageUrl: z.string().url('Please enter a valid image URL.').optional(),
  media: z.string().optional(), // comma-separated URLs
  github_repo: z.string().url('Enter a valid URL.').optional(),
  docs_url: z.string().url('Enter a valid URL.').optional(),
  status: z.enum(['active', 'completed', 'archived']).default('active'),
  tags: z.string().optional(), // comma-separated
  team: z.array(z.string()).optional(),
  teamLeaderId: z.string().optional(),
});

type ProjectFormInputs = z.infer<typeof projectSchema>;

export default function NewProjectPage() {
  const { user, isLoading, role } = useUser();
  const router = useRouter();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const firestore = useFirestore();
  const usersCollectionRef = useMemoFirebase(() => collection(firestore, 'users'), [firestore]);
  const { data: usersData } = useCollection(usersCollectionRef);
  const users = usersData?.map((doc: any) => ({ uid: doc.id, ...doc })) || [];

  const { register, handleSubmit, formState: { errors }, setValue, watch } = useForm<ProjectFormInputs>({
    resolver: zodResolver(projectSchema),
    defaultValues: {
      status: 'active',
    },
  });

  // Auto-generate slug from title if empty
  const titleValue = watch('title');
  const slugValue = watch('slug');
  useEffect(() => {
    if (titleValue && (!slugValue || slugValue.trim().length === 0)) {
      setValue('slug', slugify(titleValue), { shouldValidate: true });
    }
  }, [titleValue, slugValue, setValue]);

  const onSubmit = async (data: ProjectFormInputs) => {
    if (!user) {
      router.push('/auth/login');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await addProjectClient({
        title: data.title,
        slug: data.slug,
        description: data.description,
        imageUrl: data.imageUrl,
        media: (data.media || '')
          .split(',')
          .map((u) => u.trim())
          .filter(Boolean),
        tags: (data.tags || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        status: data.status || 'active',
        github_repo: data.github_repo || '',
        docs_url: data.docs_url || '',
        team: data.team && data.team.length ? data.team : undefined,
        teamLeaderId: data.teamLeaderId || undefined,
      });
      toast({
        title: "Project Added!",
        description: result.message,
      });
      router.push('/projects');
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Submission Failed",
        description: error instanceof Error ? error.message : "An error occurred",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="relative flex min-h-screen flex-col">
        <StarryBackground />
        <main className="flex-1 flex items-center justify-center p-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </main>
        <Footer />
      </div>
    );
  }

  // Restrict page access to project admin roles (mirror Firestore/Storage rules)
  const isProjectAdmin = !!(user && role && (
    isPresident(role, user.uid) ||
    role === 'vice_president' ||
    role === 'projects_director' ||
    role === 'chair_projects'
  ));

  if (!user) {
    router.push('/auth/login');
    return null;
  }

  if (!isProjectAdmin) {
    router.push('/projects');
    return null;
  }

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 flex items-center justify-center py-12 px-4">
        <Card className="w-full max-w-2xl bg-card/80 backdrop-blur-sm border-accent/20">
          <CardHeader>
            <CardTitle className="text-3xl text-glow">Add a New Project</CardTitle>
            <CardDescription>
              Showcase your work to the SEDS community. Fill out the details below to add your project.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="title">Project Title</Label>
                <Input id="title" {...register('title')} placeholder="e.g., SEDS-SAT-1 CubeSat" />
                {errors.title && <p className="text-sm text-destructive">{errors.title.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="slug">Slug</Label>
                <Input id="slug" {...register('slug')} placeholder="seds-sat-1" />
                {errors.slug && <p className="text-sm text-destructive">{errors.slug.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea id="description" {...register('description')} placeholder="Describe your project's goals, technology, and impact." className="min-h-[120px]" />
                {errors.description && <p className="text-sm text-destructive">{errors.description.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="imageUrl">Project Image URL</Label>
                <Input id="imageUrl" {...register('imageUrl')} placeholder="https://images.unsplash.com/your-image" />
                {errors.imageUrl && <p className="text-sm text-destructive">{errors.imageUrl.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="media">Media URLs (comma-separated)</Label>
                <Input id="media" {...register('media')} placeholder="https://postimg.cc/abc, https://ibb.co/xyz" />
                {errors.media && <p className="text-sm text-destructive">{errors.media.message as string}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="tags">Tags (comma-separated)</Label>
                <Input id="tags" {...register('tags')} placeholder="e.g., Rocketry, CubeSat, AI" />
                {errors.tags && <p className="text-sm text-destructive">{errors.tags.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select onValueChange={(v) => setValue('status', v as any, { shouldValidate: true })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
                {errors.status && <p className="text-sm text-destructive">{errors.status.message as string}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="github_repo">GitHub Repository</Label>
                <Input id="github_repo" {...register('github_repo')} placeholder="https://github.com/org/repo" />
                {errors.github_repo && <p className="text-sm text-destructive">{errors.github_repo.message as string}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="docs_url">Documentation URL</Label>
                <Input id="docs_url" {...register('docs_url')} placeholder="https://docs.example.com/project" />
                {errors.docs_url && <p className="text-sm text-destructive">{errors.docs_url.message as string}</p>}
              </div>
              <div className="space-y-2">
                <Label>Team Members</Label>
                <MultiSelect
                  options={users.map((u: any) => ({ label: u.displayName || u.email, value: u.uid }))}
                  selected={watch('team') || []}
                  onSelectedChange={(selected) => setValue('team', selected, { shouldValidate: false })}
                  placeholder="Select team members"
                />
              </div>
              <div className="space-y-2">
                <Label>Team Leader</Label>
                <Select onValueChange={(v) => setValue('teamLeaderId', v, { shouldValidate: false })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a team leader" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((u: any) => (
                      <SelectItem key={u.uid} value={u.uid}>
                        {u.displayName || u.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" size="lg" disabled={isSubmitting} className="w-full font-accent tracking-widest uppercase">
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <PlusCircle className="mr-2 h-5 w-5" />
                    Add Project
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
      <Footer />
    </div>
  );
}
