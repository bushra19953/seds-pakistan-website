"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Footer from "@/components/layout/footer";
import StarryBackground from "@/components/starry-background";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Simulated child list component that accepts a callback prop.
// In the real app, this represents the component that triggers filter or pagination changes.
function DataList({ items, onFilterChange }: { items: any[]; onFilterChange: (nextFilter: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button className="btn" onClick={() => onFilterChange("all")}>All</button>
        <button className="btn" onClick={() => onFilterChange("popular")}>Popular</button>
        <button className="btn" onClick={() => onFilterChange("recent")}>Recent</button>
      </div>
      {items.map((item, idx) => (
        <Card key={idx}>
          <CardHeader>
            <CardTitle>{item.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{item.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function ExplorePage() {
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [items, setItems] = useState<any[]>([]);

  // FIX: Stabilize the function prop with useCallback to prevent an infinite loop.
  // Root cause: passing an inline function to a child component, then referencing that
  // function in a parent useEffect dependency caused its identity to change on every render.
  // Definitive fix: wrap the function in useCallback with a stable dependency array.
  const handleFilterChange = useCallback((nextFilter: string) => {
    setFilter(nextFilter);
  }, []); // empty dependency array ensures stable identity

  // Fetch data when filter changes. Depend ONLY on stable primitives.
  // This prevents loops caused by object identity changes or unstable function props.
  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    // Simulated fetch; replace with Firestore/REST query in the actual app.
    const fetchData = async () => {
      // Example: await getDocs(query(collection(firestore, 'explore'), where('type', '==', filter)))
      await new Promise((r) => setTimeout(r, 300));
      const data = [
        { title: `Item A (${filter})`, description: "Description A" },
        { title: `Item B (${filter})`, description: "Description B" },
      ];
      if (isMounted) {
        setItems(data);
        setLoading(false);
      }
    };
    fetchData();
    return () => {
      isMounted = false;
    };
  }, [filter]);

  const content = useMemo(() => {
    if (loading) {
      return (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      );
    }
    return <DataList items={items} onFilterChange={handleFilterChange} />;
  }, [loading, items, handleFilterChange]);

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto px-4 py-8">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold">Explore</h1>
          <p className="text-muted-foreground">Discover content without performance hiccups.</p>
        </div>
        {content}
      </main>
      <Footer />
    </div>
  );
}
