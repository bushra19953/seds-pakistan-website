"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useUser, useFirestore, useDoc } from "@/firebase";
import { doc } from "firebase/firestore";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

import type { EventDoc } from "@/types/event";
import Link from "next/link";
import { CheckCircle2, Lock, Users, UploadCloud, Link2, ShieldCheck, Clock } from "lucide-react";
import useSound from 'use-sound';
import { motion, AnimatePresence } from "framer-motion";

// Embedded premium micro-sounds (Base64 MP3 snippets) for immediate auditory feedback
const SOUND_KEYPRESS = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU5LjI3LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAFAAAAZgABAgQGCAoMDhASFBYZGhwfISQnKSwvMTQ3Ojw/QUNGSUpNUVVZWl1gYmVoa25xcnd6fH+Cg4aJi46Rk5WXmpiam56goqWnqqyusLG0t7q8v8LExsdKzM/S1NfZ3N3g4uXo6+zt8PP2+Pv8/wAAAApMYXZjNTkuMjcAAAAAAAAAAAAAAAAkAMQAAAAAAABmX6dYAAAAAAAAAAAAAAAAAAAA//OUxAAAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxBUAAOENXIAAAAAMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxB8AAPIM3MAAAAAMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxCQAAQQK3EAAAAQMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const SOUND_SUCCESS = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU5LjI3LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAJAAABIgABAgQGCAoMDhASFBYZGhwfISQnKSwvMTQ3Ojw/QUNGSUpNUVVZWl1gYmVoa25xcnd6fH+Cg4aJi46Rk5WXmpiam56goqWnqqyusLG0t7q8v8LExsdKzM/S1NfZ3N3g4uXo6+zt8PP2+Pv8/wAAAApMYXZjNTkuMjcAAAAAAAAAAAAAAAAkAMQAAAAAAAABIiO4kAAAAAAAAAAAAAAAAAAAA//OUxAAAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxBUAAOENXIAAAAAMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxB8AAPIM3IAAAAAMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxCQAAQQG3IAAAAQMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxC0AAQ4JW4AAAAAMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxDQAARkJWYAAAAwMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxDoAASMIWYAAAAgMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OUxD8AASsG2YAAAAwMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";


type Props = {
  event: Partial<EventDoc> & { id?: string };
  className?: string;
  size?: "default" | "lg";
};

type CtaState = {
  label: string;
  disabled: boolean;
  icon: "check" | "lock" | "users" | "clock";
  href?: string;
};

function computeCtaState(event: Partial<EventDoc>, user: any, registration?: any, config?: any): CtaState {
  const isPublished = (event as any).status === "published" || (event as any).published === true;
  const registrationOpen = (event.registrationOpen ?? true) === true;
  const capacity = typeof event.capacity === "number" ? event.capacity : undefined;
  const attendeeCount = Array.isArray(event.attendeeIds) ? event.attendeeIds.length : 0;
  const isFull = capacity !== undefined ? attendeeCount >= capacity : false;

  if (!isPublished) {
    return { label: "Not Published", disabled: true, icon: "lock" };
  }

  if (!user) {
    const intentUrl = `/events/${event.slug || event.id}?action=checkout`;
    return {
      label: "Log in to Register",
      disabled: false,
      icon: "lock",
      href: `/auth?redirect=${encodeURIComponent(intentUrl)}`,
    };
  }

  // 🛑 ENFORCEMENT CHECK: Block UI if user is blacklisted
  const enforcementEnabled = config?.enforcementEnabled ?? true;
  if (enforcementEnabled && user.isBlacklisted === true) {
    return { label: "Account Restricted", disabled: true, icon: "lock" };
  }

  const isUserRegistered = Array.isArray(event.attendeeIds) && user.uid && event.attendeeIds.includes(user.uid);
  if (isUserRegistered) {
    return { label: "You are Registered", disabled: true, icon: "check" };
  }

  if (registration && registration.status !== 'cancelled') {
    if (registration.status === 'confirmed') {
      return { label: "You are Registered", disabled: true, icon: "check" };
    }
    return { label: "Registration Under Review", disabled: true, icon: "clock" };
  }

  if (isFull) {
    return { label: "Event Full", disabled: true, icon: "users" };
  }
  if (!registrationOpen) {
    return { label: "Registration Closed", disabled: true, icon: "lock" };
  }

  const deadline = (event as any).registrationDeadline;
  if (deadline) {
    try {
      const deadlineMs = deadline?.seconds
        ? deadline.seconds * 1000
        : deadline?.toDate
          ? deadline.toDate().getTime()
          : new Date(deadline).getTime();
      if (Date.now() > deadlineMs) {
        return { label: "Registration Closed", disabled: true, icon: "lock" };
      }
    } catch { /* ignore parse errors */ }
  }

  // CENTRALIZED ROUTING: All paid events MUST use Store Checkout
  const storeProductId = event.linkedStoreProductId || event.productId;
  const isPaid = event.paymentDetails?.isPaid;

  if (isPaid) {
    if (storeProductId) {
      return {
        label: "Pay & Register",
        disabled: false,
        icon: "check",
        href: `/checkout?productId=${storeProductId}&eventId=${event.id}&type=product`,
      };
    } else {
      // PRODUCTION GUARD: Paid events without linked product are restricted
      return {
        label: "Payment Setup Pending",
        disabled: true,
        icon: "lock"
      };
    }
  }

  // Free Event registration
  return {
    label: "Secure Your Spot",
    disabled: false,
    icon: "check",
    href: event.id ? `/events/register?eventId=${event.id}` : undefined,
  };
}

export default function EventCTA({ event, className, size = "lg" }: Props) {
  const { user } = useUser();
  const firestore = useFirestore();

  // Fetch real-time registration status from subcollection
  const regDocRef = (user?.uid && event.id) ? doc(firestore, 'events', event.id, 'registrations', user.uid) : null;
  const { data: registration } = useDoc(regDocRef);

  // Fetch global enforcement config
  const configRef = doc(firestore, 'warningConfig', 'global');
  const { data: config } = useDoc(configRef);

  const state = computeCtaState(event, user, registration, config);
  const Icon = state.icon === "check" ? CheckCircle2 : state.icon === "lock" ? Lock : state.icon === "clock" ? Clock : Users;

  const handleActionClick = () => {
    if (state.href) {
      window.location.href = state.href;
    }
  };

  return (
    <div className="flex items-center justify-start">
      <Button
        variant={state.disabled ? "outline" : "default"}
        size={size}
        className={cn(
          "w-full sm:w-auto",
          state.disabled ? "opacity-70 cursor-not-allowed" : "hover:scale-105 transition-transform duration-200",
          "shadow-lg",
          className
        )}
        disabled={state.disabled}
        onClick={handleActionClick}
      >
        <Icon className="mr-2 h-4 w-4" />
        {state.label}
      </Button>
    </div>
  );
}