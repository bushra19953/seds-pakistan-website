"use client";

import { useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Image, Text } from "@react-three/drei";
import { easing } from "maath";
import { useRouter } from "next/navigation";
import * as THREE from "three";

export function ImagePortal({ index, project, total }: { index: number; project: any; total: number }) {
    const ref = useRef<any>();
    const [hovered, setHovered] = useState(false);
    const router = useRouter();
    const { viewport } = useThree();

    // Fixed 16:9 aspect ratio
    const ASPECT_RATIO = 16 / 9;
    const isMobile = viewport.aspect < 1;

    // Calculate card dimensions to fit nicely in viewport while maintaining 16:9
    const cardWidth = isMobile
        ? viewport.width * 0.8
        : viewport.width * 0.4;
    const cardHeight = cardWidth / ASPECT_RATIO;

    // Gap between cards
    const gap = cardWidth * 0.1;

    // Position each card horizontally with gap
    const xPos = index * (cardWidth + gap);

    useFrame((state, delta) => {
        if (!ref.current) return;

        // Hover animation: Scale up slightly
        const targetScale = hovered ? 1.08 : 1;
        easing.damp3(
            ref.current.scale,
            [cardWidth * targetScale, cardHeight * targetScale, 1],
            0.15,
            delta
        );

        // Subtle lift on hover
        easing.damp(ref.current.position, 'y', hovered ? 0.15 : 0, 0.15, delta);
    });

    // Truncate title if too long
    const displayTitle = project.title?.length > 40
        ? project.title.slice(0, 37) + '...'
        : project.title;

    return (
        <group position={[xPos, 0, 0]}>
            {/* Border/Frame - slightly larger than the image */}
            <mesh position={[0, 0, -0.01]}>
                <planeGeometry args={[cardWidth + 0.08, cardHeight + 0.08]} />
                <meshBasicMaterial color={hovered ? "#3b82f6" : "#1e293b"} />
            </mesh>

            {/* The 3D Image */}
            <Image
                ref={ref}
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

            {/* Category Tag - Using R3F Text for proper scroll sync */}
            <Text
                position={[0, -(cardHeight / 2) - 0.2, 0.1]}
                fontSize={isMobile ? 0.08 : 0.1}
                color="#60a5fa"
                anchorX="center"
                anchorY="top"
                letterSpacing={0.15}
            >
                {(project.tags?.[0] || 'PROJECT').toUpperCase()}
            </Text>

            {/* Project Title - Using R3F Text for proper scroll sync */}
            <Text
                position={[0, -(cardHeight / 2) - 0.4, 0.1]}
                fontSize={isMobile ? 0.12 : 0.18}
                color="#ffffff"
                anchorX="center"
                anchorY="top"
                maxWidth={cardWidth * 0.9}
                textAlign="center"
            >
                {displayTitle}
            </Text>

            {/* Subtle hover glow effect */}
            {hovered && (
                <mesh position={[0, 0, -0.02]}>
                    <planeGeometry args={[cardWidth + 0.2, cardHeight + 0.2]} />
                    <meshBasicMaterial color="#3b82f6" transparent opacity={0.15} />
                </mesh>
            )}
        </group>
    );
}
