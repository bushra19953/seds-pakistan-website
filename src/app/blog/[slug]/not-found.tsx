import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import StarryBackground from '@/components/starry-background';

export default function NotFound() {
  return (
    <div className="relative flex min-h-screen flex-col bg-gradient-to-br from-slate-900 via-blue-900/20 to-indigo-900/30">
      <StarryBackground />
      
      <main className="flex-1 container mx-auto py-16 px-4 flex items-center justify-center">
        <Card className="bg-card/80 backdrop-blur-sm border border-primary/20 max-w-lg w-full text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold text-foreground">
              404 - Blog Post Not Found
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-muted-foreground text-lg">
              The blog post you're looking for doesn't exist or may have been moved.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button asChild className="bg-primary hover:bg-primary/90">
                <Link href="/blog">Browse All Posts</Link>
              </Button>
              <Button asChild variant="outline" className="border-blue-400/30 text-blue-300 hover:bg-blue-400/10">
                <Link href="/">Go Home</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}