'use client';

import { Card, CardContent } from '@/components/ui/card';

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground mt-1">{body}</p>
      </CardContent>
    </Card>
  );
}
