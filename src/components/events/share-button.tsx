'use client';

import { useState, useRef, useCallback } from 'react';
import { Share2, Copy, CheckCircle2, MessageCircle, Twitter, Linkedin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface ShareButtonProps {
    url: string;
    title: string;
    description?: string;
    /** 'default' = hero white variant, 'subtle' = dark slate variant */
    variant?: 'default' | 'subtle';
    className?: string;
}

export default function ShareButton({ url, title, description = '', variant = 'default', className }: ShareButtonProps) {
    const { toast } = useToast();
    const [showDropdown, setShowDropdown] = useState(false);
    const [copied, setCopied] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // ── Encode payloads ──────────────────────────────────────────────────────
    const shareText = `${title}${description ? ' — ' + description : ''}`;
    const waUrl = `https://wa.me/?text=${encodeURIComponent(shareText + '\n' + url)}`;
    const twUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(url)}`;
    const liUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;

    // ── Copy to clipboard ────────────────────────────────────────────────────
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            toast({ title: 'Link Copied!', description: 'Event link is ready to paste.' });
            setTimeout(() => setCopied(false), 2500);
        } catch {
            toast({ variant: 'destructive', title: 'Copy failed', description: 'Please copy the URL manually.' });
        }
        setShowDropdown(false);
    }, [url, toast]);

    // ── Primary share handler ────────────────────────────────────────────────
    const handleShare = useCallback(async () => {
        // Try native Web Share API first (mobile / supported browsers)
        if (typeof navigator !== 'undefined' && 'share' in navigator) {
            try {
                await navigator.share({ title, text: shareText, url });
                return; // Success — native sheet handled it
            } catch (err: any) {
                if (err?.name === 'AbortError') return; // User cancelled — don't open dropdown
                // Not supported or failed — fall through to dropdown
            }
        }
        // Fallback: show monochrome custom dropdown
        setShowDropdown((prev) => !prev);
    }, [title, shareText, url]);

    const buttonBaseClass = variant === 'default'
        ? 'h-14 rounded-xl bg-card/50 backdrop-blur-md border-border hover:bg-muted text-foreground shadow-xl'
        : 'h-14 rounded-xl bg-muted/60 backdrop-blur-md border-border hover:bg-muted text-foreground shadow-lg';

    return (
        <div className="relative">
            <Button
                variant="outline"
                size="lg"
                onClick={handleShare}
                className={cn(buttonBaseClass, 'group transition-all duration-200', className)}
                aria-label="Share this event"
            >
                <Share2 className="w-5 h-5 mr-2 transition-transform group-hover:rotate-12 duration-200" />
                Share
            </Button>

            {/* ── Monochrome Dropdown Fallback ── */}
            {showDropdown && (
                <>
                    {/* Backdrop to close on outside click */}
                    <div
                        className="fixed inset-0 z-40"
                        onClick={() => setShowDropdown(false)}
                    />
                    <div
                        ref={dropdownRef}
                        className="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 z-50 w-56 overflow-hidden rounded-2xl border border-border bg-card/95 backdrop-blur-2xl shadow-2xl shadow-black/50 animate-in fade-in slide-in-from-bottom-2"
                    >
                        {/* Glassy top border accent */}
                        <div className="h-px w-full bg-gradient-to-r from-transparent via-white/20 to-transparent" />

                        <div className="p-1.5 space-y-0.5">
                            {/* WhatsApp */}
                            <a
                                href={waUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => setShowDropdown(false)}
                                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground bg-transparent hover:bg-muted/80 transition-colors duration-150 group"
                            >
                                <MessageCircle className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                                Share via WhatsApp
                            </a>

                            {/* Twitter / X */}
                            <a
                                href={twUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => setShowDropdown(false)}
                                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground bg-transparent hover:bg-muted/80 transition-colors duration-150 group"
                            >
                                <Twitter className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                                Post on X / Twitter
                            </a>

                            {/* LinkedIn */}
                            <a
                                href={liUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={() => setShowDropdown(false)}
                                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground bg-transparent hover:bg-muted/80 transition-colors duration-150 group"
                            >
                                <Linkedin className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                                Share on LinkedIn
                            </a>

                            {/* Divider */}
                            <div className="h-px mx-3 bg-white/8 my-1" />

                            {/* Copy Link */}
                            <button
                                onClick={handleCopy}
                                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground bg-transparent hover:bg-muted/80 transition-colors duration-150 group"
                            >
                                {copied
                                    ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                                    : <Copy className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                                }
                                {copied ? 'Copied!' : 'Copy Link'}
                            </button>
                        </div>

                        <div className="h-px w-full bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                    </div>
                </>
            )}
        </div>
    );
}
