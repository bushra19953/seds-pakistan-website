"use client";

import Image from "next/image";

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Boxes } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type GalleryItem = { id: string; title: string; assetUrl: string; thumbnailUrl?: string | null };

// The <model-viewer> library is heavy (the element bundle plus its Wasm
// mesh decoders), so it is fetched only when the first model card is
// activated — never on page load, and never for an empty gallery. The
// promise is shared so several cards activating together inject the
// script exactly once.
let modelViewerLoadPromise: Promise<void> | null = null;
function loadModelViewer(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as any).customElements?.get?.('model-viewer')) return Promise.resolve();
  if (!modelViewerLoadPromise) {
    modelViewerLoadPromise = new Promise<void>((resolve) => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = 'https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js';
      script.onload = () => resolve();
      script.onerror = () => resolve();
      document.head.appendChild(script);
    });
  }
  return modelViewerLoadPromise;
}

// Help TypeScript accept the custom element in JSX
const ModelViewer = 'model-viewer' as any;

/**
 * One 3D model card body. Until the card is activated it renders only
 * the poster (the item thumbnail), so neither the model-viewer library
 * nor the multi-megabyte model file is downloaded for cards the visitor
 * never reaches. Activation happens when the card scrolls near the
 * viewport, or immediately when the visitor clicks "Load 3D model".
 * Once loaded, the viewer renders with the exact props it always had.
 */
function LazyModelViewer({ model }: { model: GalleryItem }) {
  const [activated, setActivated] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (activated) return;
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setActivated(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActivated(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [activated]);

  useEffect(() => {
    if (!activated) return;
    let cancelled = false;
    loadModelViewer().then(() => {
      if (!cancelled) setViewerReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activated]);

  if (activated && viewerReady) {
    return (
      <div className="h-[400px] w-full">
        <ModelViewer
          src={model.assetUrl}
          alt={`${model.title} 3D model`}
          poster={model.thumbnailUrl ? String(model.thumbnailUrl) : undefined}
          camera-controls
          auto-rotate
          ar
          touch-action="pan-y"
          shadow-intensity="1"
          exposure="0.9"
          style={{ height: '100%', width: '100%', touchAction: 'pan-y' }}
        />
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative h-[400px] w-full overflow-hidden rounded bg-muted/20">
      {model.thumbnailUrl ? (
        <Image
          src={String(model.thumbnailUrl)}
          alt={`${model.title} thumbnail`}
          fill
          sizes="(max-width: 768px) 100vw, 50vw"
          className="object-cover"
        />
      ) : null}
      <div className="absolute inset-0 flex items-center justify-center">
        <Button type="button" variant="secondary" onClick={() => setActivated(true)}>
          <Boxes className="mr-2 h-4 w-4" aria-hidden="true" />
          Load 3D model
        </Button>
      </div>
    </div>
  );
}

export default function GallerySection() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
                  <LazyModelViewer model={model} />
                </CardContent>
              </Card>
            </div>
          ))}
          {loading && (
            <div className="col-span-2 text-center text-muted-foreground">Loading gallery...</div>
          )}
          {!loading && error && (
            <div className="col-span-2 text-center text-destructive">
              Could not load the gallery. {error}
            </div>
          )}
          {(!loading && !error && items.length === 0) && (
            <div className="col-span-2 animate-in fade-in slide-in-from-bottom-12 duration-500">
              <Card className="bg-transparent border-accent/20 shadow-xl shadow-accent/5">
                <CardContent className="py-16 text-center">
                  <Boxes className="mx-auto mb-6 h-14 w-14 text-accent/70" aria-hidden="true" />
                  <h3 className="text-2xl md:text-3xl font-bold mb-4">No 3D models yet</h3>
                  <p className="mx-auto max-w-xl text-muted-foreground font-body text-lg mb-8">
                    Our teams are preparing interactive models of the spacecraft, rovers, and satellites we are building. Once the first models are published, you will be able to rotate, zoom, and explore them right here.
                  </p>
                  <Button asChild variant="outline">
                    <Link href="/projects">Explore our projects</Link>
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
