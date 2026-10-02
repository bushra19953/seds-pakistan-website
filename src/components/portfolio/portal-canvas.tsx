"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Image, Text, Preload } from "@react-three/drei";
import { Suspense, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as THREE from "three";

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

    if (!portalItems.length) return null;

    return (
        <div className="w-full h-[60vh] md:h-[70vh] relative bg-gradient-to-b from-black/5 to-transparent border-y border-white/10 cursor-grab active:cursor-grabbing">
            <Canvas
                gl={{ antialias: true, powerPreference: "high-performance" }}
                dpr={[1, 1.5]}
                camera={{ position: [0, 0, 5.5], fov: 40 }}
                performance={{ min: 0.5 }}
            >
                <Suspense fallback={null}>
                    <CarouselGroup portalItems={portalItems} />
                    <Preload all />
                </Suspense>
            </Canvas>

            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-white/50 font-mono tracking-[0.15em] pointer-events-none">
                <span className="hidden md:inline">◀ DRAG TO EXPLORE • CLICK TO ACCESS ▶</span>
                <span className="md:hidden">◀ SWIPE TO EXPLORE • TAP TO VIEW ▶</span>
            </div>
        </div>
    );
}
