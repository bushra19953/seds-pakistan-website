"use client";

import React from 'react';
import Image from 'next/image';
import { getYouTubeID, resolveMediaType } from '@/lib/media-utils';
import { cn } from '@/lib/utils';

interface MediaEmbedProps {
    url: string;
    alt?: string;
    className?: string;
    aspectRatio?: '16/9' | '4/3' | '1/1' | 'auto';
    priority?: boolean;
    fill?: boolean;
    width?: number;
    height?: number;
}

export const MediaEmbed: React.FC<MediaEmbedProps> = ({
    url,
    alt = "Media content",
    className,
    aspectRatio = '16/9',
    priority = false,
    fill = false,
    width,
    height,
}) => {
    const type = resolveMediaType(url);

    const containerClasses = cn(
        "relative overflow-hidden rounded-md bg-muted/20",
        {
            "aspect-video": aspectRatio === '16/9',
            "aspect-[4/3]": aspectRatio === '4/3',
            "aspect-square": aspectRatio === '1/1',
        },
        className
    );

    if (type === 'youtube') {
        const videoId = getYouTubeID(url);
        if (!videoId) return <div className={containerClasses}>Invalid Video</div>;

        return (
            <div className={containerClasses}>
                <iframe
                    src={`https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1`}
                    title={alt}
                    className="absolute inset-0 w-full h-full border-0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                ></iframe>
            </div>
        );
    }

    // Fallback to Image
    return (
        <div className={containerClasses}>
            <Image
                src={url}
                alt={alt}
                fill={fill || !width}
                width={!fill ? width : undefined}
                height={!fill ? height : undefined}
                priority={priority}
                className={cn("object-cover", { "absolute inset-0": fill || !width })}
                onError={(e) => {
                    // Fallback image if needed
                    const target = e.target as HTMLImageElement;
                    target.src = '/placeholder-image.png'; // Make sure this exists
                }}
                sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
            />
        </div>
    );
};
