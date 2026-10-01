import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';

ensureAdminInitialized();

export default async function SkillDetailPage({ params }: { params: Promise<{ skillSlug: string }> }) {
  const { skillSlug } = await params;
const slug = decodeURIComponent(skillSlug || '');
  const db = getDb();
  if (!db || !slug) {
    return <div className="container mx-auto px-4 py-12"><p>Skill not found</p></div>;
  }

  const skillsSnap = await db.collection('skills').where('slug', '==', slug).limit(1).get();
  if (skillsSnap.empty) {
    return <div className="container mx-auto px-4 py-12"><p>Skill not found</p></div>;
  }
  const skillDoc = { id: skillsSnap.docs[0].id, ...(skillsSnap.docs[0].data() as any) };
  const usersSnap = await db.collection('users').where('skillIds', 'array-contains', skillDoc.id).get();
  const users = usersSnap.docs.map((ud) => ({ id: ud.id, ...(ud.data() as any) }));

  return (
    <div className="container mx-auto px-4 py-12">
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{String(skillDoc.name || skillDoc.id)}</CardTitle>
          <CardDescription>{String(skillDoc.category || '')}</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Directory of experts</CardDescription>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <p>No members found</p>
          ) : (
            <div className="grid md:grid-cols-3 gap-4">
              {users.map((u) => {
                const initials = String(u.displayName || u.email || u.id).split(' ').map((x: string) => x[0]).join('').slice(0, 2).toUpperCase();
                return (
                  <Card key={u.id}>
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
  );
}
