"use client";

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { useFirestore } from "@/firebase/provider";
import StarryBackground from "@/components/starry-background";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import React from "react";
import {
  Mail,
  Phone,
  Instagram,
  Twitter,
  Globe,
  Link as LinkIcon,
  ExternalLink,
} from "lucide-react";

// ─── Types (match AdminContactEditor schema) ────────────────────────────────
interface ContactMethod {
  title: string;
  description?: string;
  icon?: string;
  type: "email" | "link";
  value: string;
}

interface ContactPageData {
  title?: string;
  subtitle?: string;
  contactMethods?: ContactMethod[];
}

// ─── Icon resolver ──────────────────────────────────────────────────────────
function resolveIcon(name?: string): React.ReactNode {
  const iconClass = "h-5 w-5 text-primary flex-shrink-0";
  switch ((name || "").toLowerCase()) {
    case "mail": return <Mail className={iconClass} />;
    case "phone": return <Phone className={iconClass} />;
    case "instagram": return <Instagram className={iconClass} />;
    case "twitter": return <Twitter className={iconClass} />;
    case "globe": return <Globe className={iconClass} />;
    default: return <LinkIcon className={iconClass} />;
  }
}

// ─── Zod schema ─────────────────────────────────────────────────────────────
const contactSchema = z.object({
  name: z.string().min(2, { message: "Name must be at least 2 characters." }).max(200),
  email: z.string().email({ message: "Please enter a valid email." }).max(320),
  message: z.string().min(10, { message: "Message must be at least 10 characters." }).max(5000),
});

type ContactInput = z.infer<typeof contactSchema>;

// ─── Page ───────────────────────────────────────────────────────────────────
export default function ContactPage() {
  const db = useFirestore();
  const { toast } = useToast();
  const [cmsData, setCmsData] = useState<ContactPageData | null>(null);
  const [cmsLoading, setCmsLoading] = useState(true);

  const { register, handleSubmit, formState: { errors, isSubmitting }, reset } =
    useForm<ContactInput>({ resolver: zodResolver(contactSchema) });

  // ── Fetch CMS contact page data from pages/contact ──────────────────────
  useEffect(() => {
    const fetchContact = async () => {
      try {
        const ref = doc(db, "pages", "contact");
        const snap = await getDoc(ref);
        if (snap.exists()) {
          setCmsData(snap.data() as ContactPageData);
        }
      } catch {
        // tolerate missing — fall back to defaults
      } finally {
        setCmsLoading(false);
      }
    };
    fetchContact();
  }, [db]);

  // ── Form submit ──────────────────────────────────────────────────────────
  const onSubmit = async (values: ContactInput) => {
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429) {
          throw new Error("You've reached the daily message limit. Please try again tomorrow.");
        }
        throw new Error(data?.error || "Failed to send message");
      }
      toast({ title: "Message Sent!", description: "Thanks for reaching out — we'll get back to you soon." });
      reset();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Error", description: e?.message || "Could not send message." });
    }
  };

  // ── Derived display values (CMS overrides fallback defaults) ─────────────
  const pageTitle = cmsData?.title || "Contact Us";
  const pageSubtitle = cmsData?.subtitle || "We'd love to hear from you. Send us a message using the form below.";
  const contactMethods: ContactMethod[] = Array.isArray(cmsData?.contactMethods)
    ? cmsData!.contactMethods.filter((m) => m.value)
    : [];

  return (
    <div className="relative flex min-h-screen flex-col">
      <StarryBackground />
      <main className="flex-1 container mx-auto py-12 px-4">
        {/* ── Hero ── */}
        <div className="relative mb-10 text-center">
          <h1 className="text-4xl sm:text-5xl font-bold text-glow">{pageTitle}</h1>
          <p className="mt-3 text-muted-foreground max-w-2xl mx-auto text-lg">{pageSubtitle}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 max-w-5xl mx-auto">
          {/* ── Left: Contact Methods from CMS ── */}
          {!cmsLoading && contactMethods.length > 0 && (
            <div className="lg:col-span-2 space-y-4">
              <h2 className="text-xl font-semibold mb-4">Get in Touch</h2>
              {contactMethods.map((method, idx) => (
                <Card
                  key={idx}
                  className="bg-card/80 backdrop-blur-sm border-primary/20 hover:border-primary/50 transition-colors"
                >
                  <CardContent className="flex items-start gap-4 pt-5 pb-5">
                    <div className="mt-0.5">{resolveIcon(method.icon)}</div>
                    <div className="min-w-0">
                      <div className="font-semibold text-sm">{method.title}</div>
                      {method.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                          {method.description}
                        </p>
                      )}
                      {method.type === "email" ? (
                        <a
                          href={`mailto:${method.value}`}
                          className="text-primary text-sm hover:underline flex items-center gap-1 mt-1 truncate"
                        >
                          {method.value}
                        </a>
                      ) : (
                        <a
                          href={method.value}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary text-sm hover:underline flex items-center gap-1 mt-1"
                        >
                          Visit <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* ── Right: Contact Form ── */}
          <div className={contactMethods.length > 0 && !cmsLoading ? "lg:col-span-3" : "lg:col-span-5"}>
            <Card className="bg-card/80 backdrop-blur-sm border-primary/20">
              <CardHeader>
                <CardTitle>Send a Message</CardTitle>
                <CardDescription>Fill out the form and we&apos;ll respond as soon as possible.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                  <div>
                    <Label htmlFor="name">Name</Label>
                    <Input id="name" placeholder="Your name" {...register("name")} />
                    {errors.name && (
                      <p className="text-red-500 text-sm mt-1">{errors.name.message}</p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" type="email" placeholder="you@example.com" {...register("email")} />
                    {errors.email && (
                      <p className="text-red-500 text-sm mt-1">{errors.email.message}</p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="message">Message</Label>
                    <Textarea
                      id="message"
                      rows={6}
                      placeholder="How can we help?"
                      {...register("message")}
                    />
                    {errors.message && (
                      <p className="text-red-500 text-sm mt-1">{errors.message.message}</p>
                    )}
                  </div>
                  <Button type="submit" disabled={isSubmitting} className="w-full">
                    {isSubmitting ? "Sending…" : "Send Message"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
