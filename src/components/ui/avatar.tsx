"use client"

import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "@/lib/utils"

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
      className
    )}
    {...props}
  />
))
Avatar.displayName = AvatarPrimitive.Root.displayName

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, referrerPolicy = 'no-referrer', crossOrigin, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn("aspect-square h-full w-full", className)}
    // referrerPolicy 'no-referrer' improves reliability for Google-hosted avatars.
    // crossOrigin deliberately has NO default (T2-4, 2026-11-02): a CORS-mode load
    // requires Access-Control-Allow-Origin, which Google profile-photo (a-/) URLs do
    // not reliably send, so the old 'anonymous' default hard-failed images that a
    // plain <img> loads fine, and every re-render re-logged the failure. A future
    // consumer that genuinely needs CORS-clean pixels must opt in explicitly with
    // crossOrigin="anonymous" and tolerate the fallback when the header is absent.
    referrerPolicy={referrerPolicy as any}
    crossOrigin={crossOrigin as any}
    {...props}
  />
))
AvatarImage.displayName = AvatarPrimitive.Image.displayName

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, delayMs = 300, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-muted",
      className
    )}
    // Show fallback quickly if avatar is slow or fails
    delayMs={delayMs}
    {...props}
  />
))
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

export { Avatar, AvatarImage, AvatarFallback }
