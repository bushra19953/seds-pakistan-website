"use client";

import React, { useState, useEffect } from 'react';

interface Star {
  id: number;
  top: number;
  left: number;
  animationDelay: number;
}

interface StarryBackgroundProps {
  children?: React.ReactNode;
  starCount?: number;
}

const StarryBackground: React.FC<StarryBackgroundProps> = ({ children, starCount = 50 }) => {
  const [stars, setStars] = useState<Star[]>([]);

  useEffect(() => {
    const newStars: Star[] = [];
    for (let i = 0; i < starCount; i++) {
      newStars.push({
        id: i,
        top: Math.random() * 100,
        left: Math.random() * 100,
        animationDelay: Math.random() * 5,
      });
    }
    setStars(newStars);
  }, [starCount]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {stars.map((star) => (
        <div
          key={star.id}
          className="star"
          style={{
            top: `${star.top}%`,
            left: `${star.left}%`,
            animationDelay: `${star.animationDelay}s`,
          }}
        ></div>
      ))}

      {/* Pakistani Constellation - Crescent & Star - LARGE & VISIBLE */}
      {/* Pakistani Constellation - Crescent & Star - HIGH VISIBILITY SOLID */}
      <div
        className="absolute top-[18%] right-[5%] z-[9999]"
        aria-hidden="true"
        style={{ pointerEvents: 'none' }}
      >
        <svg
          width="200"
          height="200"
          viewBox="0 0 100 100"
          className="w-32 h-32 md:w-48 md:h-48 lg:w-64 lg:h-64"
        >
          {/* Crescent Moon - High Visibility Neon Green */}
          {/* Using evenodd rule for robust cutout rendering */}
          <path
            d="M60 10 A40 40 0 1 1 60 90 A30 30 0 1 0 60 10 Z"
            fill="#39FF14"
            fillRule="evenodd"
            transform="rotate(-20 50 50)"
          />
          {/* 5-Pointed Star - Solid White - Centered in the opening */}
          <polygon
            points="75,38 79,48 90,48 81,55 84,65 75,58 66,65 69,55 60,48 71,48"
            fill="#FFFFFF"
            transform="rotate(-20 50 50)"
          />
        </svg>
      </div>

      {children}
      <style jsx>{`
        .star {
          position: absolute;
          width: 2px;
          height: 2px;
          background-color: white;
          border-radius: 50%;
          opacity: 0;
          animation: twinkle 5s infinite ease-in-out;
        }

        @keyframes twinkle {
          0% {
            opacity: 0;
          }
          50% {
            opacity: 1;
          }
          100% {
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
};

export default StarryBackground;