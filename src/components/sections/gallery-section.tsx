import Image from "next/image";
"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type GalleryItem = { id: string; title: string; assetUrl: string; thumbnailUrl?: string | null };

export default function GallerySection() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Load the model-viewer script on the client if not already registered
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isDefined = !!(window as any).customElements?.get?.('model-viewer');
    if (isDefined) return;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = 'https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js';
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchItems() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch('/api/gallery-assets');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        const list: GalleryItem[] = (json.items || []).map((x: any) => ({
          id: x.id,
          title: x.title,
          assetUrl: x.assetUrl,
          thumbnailUrl: x.thumbnailUrl || null,
        }));
        setItems(list);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load gallery');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchItems();
    return () => { cancelled = true; };
  }, []);

  // Help TypeScript accept the custom element in JSX
  const ModelViewer = 'model-viewer' as any;

  return (
    <section id="gallery" className="py-20 md:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-16 animate-in fade-in slide-in-from-bottom-12 duration-500">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 text-glow">3D Spacecraft Gallery</h2>
          <p className="max-w-2xl mx-auto text-muted-foreground font-body text-lg">
            Interact with detailed models using touch, mouse, or AR-enabled devices.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
          {(loading ? [] : items).map((model, index) => (
            <div
              key={model.id}
              className="animate-in fade-in slide-in-from-bottom-12 duration-500"
              style={{ animationDelay: `${index * 150}ms` }}
            >
              <Card className="bg-transparent border-accent/20 shadow-xl shadow-accent/5 h-full flex flex-col">
                <CardHeader>
                  <CardTitle className="text-2xl text-center">{model.title}</CardTitle>
                </CardHeader>
                <CardContent className="p-2 flex-grow">
                  {model.thumbnailUrl && (
                    <div className="mb-2 w-full flex justify-center">
                      <Image src={String(model.thumbnailUrl)} alt={`${model.title} thumbnail`} width={320} height={128} className="h-32 w-auto object-cover rounded" />
                    </div>
                  )}
                  <div className="h-[400px] w-full">
                    <ModelViewer
                      src={model.assetUrl}
                      alt={`${model.title} 3D model`}
                      camera-controls
                      auto-rotate
                      ar
                      touch-action="pan-y"
                      shadow-intensity="1"
                      exposure="0.9"
                      style={{ height: '100%', width: '100%', touchAction: 'pan-y' }}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          ))}
          {loading && (
            <div className="col-span-2 text-center text-muted-foreground">Loading gallery...</div>
          )}
          {(!loading && items.length === 0) && (
            <div className="col-span-2 text-center text-muted-foreground">No assets available.</div>
          )}
        </div>
      </div>
    </section>
  );
}
