/**
 * Media Utilities for Unified Media System
 */

/**
 * Extracts YouTube Video ID from various URL formats
 * Supports: youtube.com/watch?v=..., youtu.be/..., youtube.com/embed/...
 */
export function getYouTubeID(url: string): string | null {
    if (!url) return null;

    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i;
    const match = url.match(regex);
    return match ? match[1] : null;
}

/**
 * Checks if a URL is a YouTube link
 */
export function isYouTubeUrl(url: string): boolean {
    return !!getYouTubeID(url);
}

/**
 * Normalizes a URL to ensure it uses HTTPS
 */
export function normalizeMediaUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('http://')) {
        return url.replace('http://', 'https://');
    }
    return url;
}

/**
 * Resolves the type of media from a URL
 */
export function resolveMediaType(url: string): 'image' | 'youtube' | 'video' {
    if (isYouTubeUrl(url)) return 'youtube';

    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith('.mp4') || lowerUrl.endsWith('.webm') || lowerUrl.endsWith('.ogg')) {
        return 'video';
    }

    return 'image';
}
