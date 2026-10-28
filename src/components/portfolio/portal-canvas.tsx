"use client";

import React from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Image, Text, Preload } from "@react-three/drei";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as THREE from "three";
import { isWebGLSupported } from "@/lib/webgl-utils";
import { normalizePortalImageUrl } from "@/lib/portal-image-url";

// Non-suspending stand-in shown while one card's texture/font loads: the
// card border plus a plain dark plane at card size. Rendered as a Suspense
// fallback, so it must never contain suspending children itself.
function CardPlaceholder({ cardWidth, cardHeight }: { cardWidth: number; cardHeight: number }) {
    return (
        <group>
            <mesh position={[0, 0, -0.02]}>
                <planeGeometry args={[cardWidth + 0.06, cardHeight + 0.06]} />
                <meshBasicMaterial color="#1e293b" />
            </mesh>
            <mesh>
                <planeGeometry args={[cardWidth, cardHeight]} />
                <meshBasicMaterial color="#0b1220" />
            </mesh>
        </group>
    );
}

// Content-ready probe: lives inside the outer <Suspense> boundary, so it
// can only mount once every suspending resource in that tree (carousel,
// card textures, troika font, <Preload all />) has actually resolved. Its
// mount effect is the signal that disarms PortalCanvas's content-ready
// watchdog; a hung fetch keeps the boundary suspended forever, the probe
// never mounts, and the watchdog falls back to the static grid.
function ContentReadyProbe({ onReady }: { onReady: () => void }) {
    useEffect(() => {
        onReady();
    }, [onReady]);
    return null;
}

// Individual Card Component
function GalleryCard({
    project,
    position,
    cardWidth,
    cardHeight,
    isMobile
}: {
    project: any;
    position: [number, number, number];
    cardWidth: number;
    cardHeight: number;
    isMobile: boolean;
}) {
    const meshRef = useRef<THREE.Mesh>(null);
    const [hovered, setHovered] = useState(false);
    const router = useRouter();

    const displayTitle = project.title?.length > 35
        ? project.title.slice(0, 32) + '...'
        : project.title;

    useFrame((state, delta) => {
        if (!meshRef.current) return;
        // Simple scale animation on hover
        const targetScale = hovered ? 1.05 : 1;
        meshRef.current.scale.x += (cardWidth * targetScale - meshRef.current.scale.x) * 0.1;
        meshRef.current.scale.y += (cardHeight * targetScale - meshRef.current.scale.y) * 0.1;
    });

    return (
        <group position={position}>
            {/* Border (non-suspending; always rendered) */}
            <mesh position={[0, 0, -0.01]}>
                <planeGeometry args={[cardWidth + 0.06, cardHeight + 0.06]} />
                <meshBasicMaterial color={hovered ? "#3b82f6" : "#1e293b"} />
            </mesh>

            {/* Suspending content (image texture + troika text) is isolated
                behind a per-card Suspense boundary: one hanging texture or
                font only blanks this card's interior (placeholder frame),
                never the carousel or the other cards. */}
            <Suspense fallback={<CardPlaceholder cardWidth={cardWidth} cardHeight={cardHeight} />}>
                {/* Image */}
                <Image
                    ref={meshRef}
                    url={project.image}
                    transparent
                    side={THREE.DoubleSide}
                    scale={[cardWidth, cardHeight]}
                    onPointerOver={() => { setHovered(true); document.body.style.cursor = 'pointer'; }}
                    onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
                    onClick={() => router.push(`/projects/detail?slug=${project.slug}`)}
                >
                    <planeGeometry args={[1, 1]} />
                </Image>

                {/* Tag */}
                <Text
                    position={[0, -(cardHeight / 2) - 0.15, 0.1]}
                    fontSize={isMobile ? 0.06 : 0.08}
                    color="#60a5fa"
                    anchorX="center"
                    anchorY="top"
                    letterSpacing={0.12}
                >
                    {(project.tags?.[0] || 'PROJECT').toUpperCase()}
                </Text>

                {/* Title */}
                <Text
                    position={[0, -(cardHeight / 2) - 0.32, 0.1]}
                    fontSize={isMobile ? 0.1 : 0.14}
                    color="#ffffff"
                    anchorX="center"
                    anchorY="top"
                    maxWidth={cardWidth * 0.95}
                    textAlign="center"
                >
                    {displayTitle}
                </Text>
            </Suspense>
        </group>
    );
}

// Carousel Controller - handles auto-scroll and drag
function CarouselGroup({ portalItems }: { portalItems: any[] }) {
    const groupRef = useRef<THREE.Group>(null);
    const { viewport } = useThree();
    const isDragging = useRef(false);
    const dragStart = useRef(0);
    const scrollOffset = useRef(0);
    const targetOffset = useRef(0);

    const isMobile = viewport.aspect < 1;
    const ASPECT_RATIO = 16 / 9;

    // Card dimensions (maximized for visual impact)
    const cardWidth = isMobile ? viewport.width * 0.9 : viewport.width * 0.6;
    const cardHeight = cardWidth / ASPECT_RATIO;
    const gap = cardWidth * 0.12;
    const totalWidth = portalItems.length * (cardWidth + gap);

    // Auto-scroll speed (very slow for cinematic effect)
    const autoScrollSpeed = 0.003;

    useFrame((state, delta) => {
        if (!groupRef.current) return;

        // Auto-scroll when not dragging
        if (!isDragging.current) {
            targetOffset.current += autoScrollSpeed;
        }

        // Infinite loop: reset position when we've scrolled past all items
        const maxScroll = totalWidth - viewport.width * 0.5;
        if (targetOffset.current > maxScroll) {
            targetOffset.current = 0;
            scrollOffset.current = 0;
        } else if (targetOffset.current < 0) {
            targetOffset.current = maxScroll;
            scrollOffset.current = maxScroll;
        }

        // Smooth lerp to target position
        scrollOffset.current += (targetOffset.current - scrollOffset.current) * 0.08;

        // Apply position
        groupRef.current.position.x = -scrollOffset.current;
    });

    // Handle pointer events for manual control
    const onPointerDown = (e: any) => {
        isDragging.current = true;
        dragStart.current = e.point.x;
    };

    const onPointerMove = (e: any) => {
        if (!isDragging.current) return;
        const delta = dragStart.current - e.point.x;
        targetOffset.current += delta * 2;
        dragStart.current = e.point.x;
    };

    const onPointerUp = () => {
        isDragging.current = false;
    };

    return (
        <group
            ref={groupRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
        >
            {/* Invisible hit area for drag detection */}
            <mesh position={[totalWidth / 2 - cardWidth / 2, 0, -0.5]} visible={false}>
                <planeGeometry args={[totalWidth + viewport.width, viewport.height * 2]} />
                <meshBasicMaterial transparent opacity={0} />
            </mesh>

            {portalItems.map((item, i) => (
                <GalleryCard
                    key={item.id}
                    project={item}
                    position={[i * (cardWidth + gap), 0.15, 0]}
                    cardWidth={cardWidth}
                    cardHeight={cardHeight}
                    isMobile={isMobile}
                />
            ))}
        </group>
    );
}

// Static fallback shown when WebGL is unavailable or fails to initialize.
// Renders the same gallery items as plain image cards with an inline SVG
// orbit illustration, so the section never appears as a silent black box.
export function PortalStaticFallback({ items }: { items: any[] }) {
    return (
        <div
            className="w-full relative bg-gradient-to-b from-black/5 to-transparent border-y border-border py-8"
            data-testid="portal-static-fallback"
            role="img"
            aria-label="Showcase gallery (static view)"
        >
            <svg
                viewBox="0 0 120 24"
                className="mx-auto mb-6 h-6 w-auto text-primary/60"
                aria-hidden="true"
                focusable="false"
            >
                <circle cx="60" cy="12" r="4" fill="currentColor" opacity="0.8" />
                <ellipse cx="60" cy="12" rx="52" ry="9" fill="none" stroke="currentColor" strokeWidth="0.7" opacity="0.5" />
                <circle cx="112" cy="10" r="1.6" fill="currentColor" />
                <circle cx="10" cy="15" r="1.2" fill="currentColor" opacity="0.7" />
            </svg>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 px-4 md:px-8">
                {items.slice(0, 8).map((item) => (
                    <figure key={item.id} className="overflow-hidden rounded-xl border border-border bg-card/60">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={item.image}
                            alt={item.title}
                            className="h-40 w-full object-cover"
                            loading="lazy"
                            onError={(e) => {
                                // Swap once to a known-good public asset. If
                                // the swap target itself errors, the guard
                                // leaves it alone instead of looping.
                                const el = e.currentTarget;
                                if (!el.src.includes('/assets/logo.png')) {
                                    el.src = '/assets/logo.png';
                                }
                            }}
                        />
                        <figcaption className="p-3">
                            <p className="text-xs font-mono uppercase tracking-widest text-primary/70">
                                {(item.tags?.[0] || 'PROJECT').toUpperCase()}
                            </p>
                            <p className="mt-1 text-sm font-semibold text-foreground leading-[1.4]">{item.title}</p>
                        </figcaption>
                    </figure>
                ))}
            </div>
        </div>
    );
}

export function PortalCanvas({ projects }: { projects: any[] }) {
    const portalItems = useMemo(() => {
        return projects.map((p) => ({
            id: p.id,
            title: p.title,
            slug: p.slug,
            image: p.image ? normalizePortalImageUrl(p.image) : '/assets/logo.png',
            tags: [p.tag || 'ENGINEERING']
        }));
    }, [projects]);

    // WebGL gate: fall back to the static view when WebGL is unsupported,
    // when no canvas element appears within 1.5 seconds, or when the
    // carousel content never actually mounts (content-ready watchdog).
    const [webglState, setWebglState] = useState<'pending' | 'ready' | 'fallback'>('pending');
    const containerRef = useRef<HTMLDivElement>(null);

    // Identity of the current item set. A fresh set of items is a new
    // content attempt: it re-arms the watchdog and, if the previous set
    // latched into the fallback, earns the 3D view one more try.
    const itemsSignature = useMemo(() => portalItems.map((i) => i.id).join(','), [portalItems]);
    const contentReadyRef = useRef(false);
    const armedSignatureRef = useRef<string | null>(null);
    const latchedSignatureRef = useRef<string | null>(null);

    // A new item set invalidates any earlier ready signal. Reset during
    // render (before the new tree commits) because child effects — the
    // probe included — run before this component's own effects, so an
    // effect-side reset would erase a legitimate same-commit signal.
    const [prevItemsSignature, setPrevItemsSignature] = useState(itemsSignature);
    if (prevItemsSignature !== itemsSignature) {
        setPrevItemsSignature(itemsSignature);
        contentReadyRef.current = false;
        armedSignatureRef.current = null;
    }

    const handleContentReady = useCallback(() => {
        contentReadyRef.current = true;
    }, []);

    useEffect(() => {
        if (!isWebGLSupported()) {
            setWebglState('fallback');
            return;
        }
        const timer = setTimeout(() => {
            const canvasEl = containerRef.current?.querySelector('canvas');
            if (!canvasEl) {
                setWebglState((prev) => (prev === 'ready' ? prev : 'fallback'));
            }
        }, 1500);
        return () => clearTimeout(timer);
    }, []);

    // Content-ready watchdog. Every card texture and the troika font load
    // behind one <Suspense fallback={null}>: if any single fetch HANGS
    // (dead image host, blocked CDN), the boundary never resolves, the
    // canvas element exists but stays empty, nothing throws, and neither
    // the gate above nor the parent error boundary can fire. The probe
    // inside the boundary only mounts once the content tree resolves; if
    // it has not signalled within 4000ms we render the static grid.
    // Fallback is latched for the current items signature (no
    // flip-flopping, even if content trickles in afterwards); a fresh
    // items signature re-arms the 3D attempt once.
    useEffect(() => {
        if (!portalItems.length || !isWebGLSupported()) return;

        if (webglState === 'fallback') {
            if (latchedSignatureRef.current !== itemsSignature) {
                latchedSignatureRef.current = null;
                armedSignatureRef.current = null;
                setWebglState('pending');
            }
            return;
        }

        if (armedSignatureRef.current !== itemsSignature) {
            armedSignatureRef.current = itemsSignature;
        }

        const timer = setTimeout(() => {
            if (!contentReadyRef.current) {
                latchedSignatureRef.current = itemsSignature;
                setWebglState('fallback');
            }
        }, 4000);
        return () => clearTimeout(timer);
    }, [webglState, itemsSignature, portalItems.length]);

    if (!portalItems.length) return null;

    if (webglState === 'fallback') {
        return <PortalStaticFallback items={portalItems} />;
    }

    return (
        <div ref={containerRef} className="w-full h-[60vh] md:h-[70vh] relative bg-gradient-to-b from-black/5 to-transparent border-y border-border cursor-grab active:cursor-grabbing">
            <Canvas
                gl={{ antialias: true, powerPreference: "high-performance" }}
                dpr={[1, 1.5]}
                camera={{ position: [0, 0, 5.5], fov: 40 }}
                performance={{ min: 0.5 }}
                onCreated={() => setWebglState('ready')}
            >
                <Suspense fallback={null}>
                    <ContentReadyProbe onReady={handleContentReady} />
                    <CarouselGroup portalItems={portalItems} />
                    <Preload all />
                </Suspense>
            </Canvas>

            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs text-foreground/50 font-mono tracking-[0.15em] pointer-events-none">
                <span className="hidden md:inline">◀ DRAG TO EXPLORE • CLICK TO ACCESS ▶</span>
                <span className="md:hidden">◀ SWIPE TO EXPLORE • TAP TO VIEW ▶</span>
            </div>
        </div>
    );
}
