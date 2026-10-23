"use client";

import React from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Image, Text, Preload } from "@react-three/drei";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as THREE from "three";
import { isWebGLSupported } from "@/lib/webgl-utils";

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
            {/* Border */}
            <mesh position={[0, 0, -0.01]}>
                <planeGeometry args={[cardWidth + 0.06, cardHeight + 0.06]} />
                <meshBasicMaterial color={hovered ? "#3b82f6" : "#1e293b"} />
            </mesh>

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
            image: p.image || '/images/placeholder-space.jpg',
            tags: [p.tag || 'ENGINEERING']
        }));
    }, [projects]);

    // WebGL gate: fall back to the static view when WebGL is unsupported,
    // or when the renderer has not initialized within 1.5 seconds.
    const [webglState, setWebglState] = useState<'pending' | 'ready' | 'fallback'>('pending');
    const containerRef = useRef<HTMLDivElement>(null);

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
