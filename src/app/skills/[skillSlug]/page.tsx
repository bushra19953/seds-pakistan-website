import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SearchX, Users } from 'lucide-react';
import Footer from '@/components/layout/footer';
import StarryBackground from '@/components/starry-background';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

ensureAdminInitialized();

function SkillNotFound() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 py-12 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20 max-w-xl mx-auto">
            <CardContent className="py-12 text-center">
              <SearchX className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <h1 className="text-2xl font-headline mb-2">Skill not found</h1>
              <p className="text-muted-foreground mb-6">This skill does not exist or is no longer listed.</p>
              <Button asChild>
                <Link href="/skills">Browse all skills</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
      <Footer />
    </div>
  );
}

export default async function SkillDetailPage({ params }: { params: Promise<{ skillSlug: string }> }) {
  const { skillSlug } = await params;
const slug = decodeURIComponent(skillSlug || '');
  const db = getDb();
  if (!db || !slug) {
    return <SkillNotFound />;
  }

  const skillsSnap = await db.collection('skills').where('slug', '==', slug).limit(1).get().catch(() => null);
  if (!skillsSnap || skillsSnap.empty) {
    return <SkillNotFound />;
  }
  const skillDoc = { id: skillsSnap.docs[0].id, ...(skillsSnap.docs[0].data() as any) };
  const usersSnap = await db.collection('users').where('skillIds', 'array-contains', skillDoc.id).get().catch(() => null);
  const users = usersSnap ? usersSnap.docs.map((ud) => ({ id: ud.id, ...(ud.data() as any) })) : [];

  const skillName = String(skillDoc.name || skillDoc.id);
  const skillCategory = String(skillDoc.category || '');

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 py-12 md:py-24">
        <div className="container mx-auto px-4 md:px-6">
          <div className="text-center mb-10">
            {skillCategory ? (
              <div className="text-sm uppercase tracking-widest text-muted-foreground mb-3">{skillCategory}</div>
            ) : null}
            <h1 className="text-5xl md:text-7xl font-headline tracking-tighter text-foreground">{skillName}</h1>
          </div>
          <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
            <CardHeader>
              <CardTitle>Members</CardTitle>
              <CardDescription>Directory of experts</CardDescription>
            </CardHeader>
            <CardContent>
              {users.length === 0 ? (
                <div className="py-8 text-center">
                  <Users className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
                  <p className="font-medium">No members found</p>
                  <p className="text-sm text-muted-foreground mt-1">No members have added this skill yet.</p>
                </div>
              ) : (
                <div className="grid md:grid-cols-3 gap-4">
                  {users.map((u) => {
                    const initials = String(u.displayName || u.email || u.id).split(' ').map((x: string) => x[0]).join('').slice(0, 2).toUpperCase();
                    return (
                      <Card key={u.id} className="bg-card/80 backdrop-blur-sm border-primary/20">
                        <CardContent className="p-4 flex items-center gap-3">
                          <Avatar className="h-10 w-10"><AvatarImage src={String(u.photoURL || '')} /><AvatarFallback>{initials}</AvatarFallback></Avatar>
                          <div>
                            <div className="font-medium">{String(u.displayName || u.email || u.id)}</div>
                            <div className="text-sm text-muted-foreground">{String(u.role || '')}</div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
      <Footer />
    </div>
  );
}
