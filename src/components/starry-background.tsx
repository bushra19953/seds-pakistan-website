
"use client";

import { useState, useEffect, useMemo } from 'react';

const createStars = (count: number, size: number, speed: number, opacity: number) => {
  return Array.from({ length: count }, (_, i) => {
    const starSize = (Math.random() * 0.5 + 0.5) * size;
    return {
      id: `${size}-${i}`,
      size: starSize,
      style: {
        left: `${Math.random() * 100}%`,
        top: `${Math.random() * 100}%`,
        width: `${starSize}px`,
        height: `${starSize}px`,
        opacity: Math.random() * 0.5 + 0.5 * opacity,
        animation: `twinkle ${Math.random() * 5 + speed}s linear infinite`,
        animationDelay: `${Math.random() * 2}s`,
      },
    };
  });
};


export default function StarryBackground() {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const stars = useMemo(() => {
    if (!isMounted) return [];
    // Reduced star counts for better performance (was 70/20/10 = 100 total)
    const starLayer1 = createStars(30, 1, 5, 0.6); // Small, slow, dim
    const starLayer2 = createStars(10, 2, 8, 0.8); // Medium, medium speed, brighter
    const starLayer3 = createStars(5, 3, 12, 1.0); // Large, fast, brightest
    return [...starLayer1, ...starLayer2, ...starLayer3];
  }, [isMounted]);

  if (!isMounted) return null;

  return (
    <div className="fixed inset-0 -z-10 pointer-events-none dark:block hidden">
      <div className="absolute inset-0 bg-background">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/30 to-background" />
      </div>
      {stars.map((star) => (
        <div
          key={star.id}
          className="absolute rounded-full bg-white"
          style={star.style}
        />
      ))}

      {/* Pakistani Constellation - Crescent & Star - LARGE & VISIBLE */}
      <div
        className="absolute top-[5%] right-[3%] md:right-[6%] lg:right-[8%] z-50"
        aria-hidden="true"
        style={{
          filter: 'drop-shadow(0 0 25px rgba(0, 200, 83, 0.6)) drop-shadow(0 0 50px rgba(1, 65, 28, 0.4))'
        }}
      >
        <svg
          width="150"
          height="150"
          viewBox="0 0 100 100"
          className="w-24 h-24 md:w-32 md:h-32 lg:w-40 lg:h-40"
        >
          <defs>
            <linearGradient id="crescentGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#00C853" stopOpacity="1" />
              <stop offset="40%" stopColor="#01411C" stopOpacity="1" />
              <stop offset="100%" stopColor="#004D40" stopOpacity="0.95" />
            </linearGradient>
            <filter id="crescentGlow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="4" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {/* Crescent Moon - Pakistani Flag Green */}
          <path
            d="M50 10 A40 40 0 1 1 50 90 A30 30 0 1 0 50 10"
            fill="url(#crescentGradient)"
            filter="url(#crescentGlow)"
          />
          {/* 5-Pointed Star - Bright White with Glow */}
          <polygon
            points="78,28 81,36 90,36 83,42 86,50 78,44 70,50 73,42 66,36 75,36"
            fill="#ffffff"
            filter="url(#crescentGlow)"
          />
        </svg>
      </div>
    </div>
  );
}
