"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useUser } from "@/firebase/auth/use-user";
import { Bug, Send, Loader2, Lightbulb, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import html2canvas from "html2canvas";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "@/firebase";
import Image from "next/image";

export default function BugReportButton() {
  const { user } = useUser();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"bug" | "suggestion">("bug");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  const reset = () => {
    setSubject("");
    setDescription("");
    setType("bug");
    setSent(false);
    setScreenshot(null);
  };

  const handleCapture = async () => {
    setIsCapturing(true);
    try {
      // Small delay to let popover close/settle if needed, although capture occurs before popover open state is true
      const canvas = await html2canvas(document.body, {
        allowTaint: true,
        useCORS: true,
        logging: false,
        scale: 0.8, // Downscale for storage efficiency
      });
      // Aggressive WebP compression to keep size < 150KB
      const dataUrl = canvas.toDataURL("image/webp", 0.5);
      setScreenshot(dataUrl);
    } catch (err) {
      console.error("Screenshot capture failed:", err);
    } finally {
      setIsCapturing(false);
    }
  };

  const handleSubmit = async () => {
    if (!user || !subject.trim() || !description.trim()) return;
    setSending(true);
    try {
      let screenshotUrl = null;

      // 1. If screenshot exists, upload to Firebase Storage
      if (screenshot) {
        const reportId = `report_${Date.now()}`;
        const storageRef = ref(storage, `bug-reports/${reportId}/screenshot.webp`);
        
        // Convert base64 to blob
        const res_blob = await fetch(screenshot);
        const blob = await res_blob.blob();
        
        // Verify size limit (Hard check on client as well)
        if (blob.size > 500 * 1024) {
          throw new Error("Screenshot too large. Please try again.");
        }

        await uploadBytes(storageRef, blob, { contentType: 'image/webp' });
        screenshotUrl = await getDownloadURL(storageRef);
      }

      // 2. Submit to API
      const token = await user.getIdToken();
      const res = await fetch("/api/admin/bug-report", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type,
          subject: subject.trim(),
          description: description.trim(),
          page: pathname,
          screenshotUrl,
        }),
      });
      if (!res.ok) throw new Error("Failed to submit report");
      setSent(true);
      setTimeout(() => {
        setOpen(false);
        reset();
      }, 2000);
    } catch (err: any) {
      alert(err.message || "Failed to submit. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={async (v) => { 
      setOpen(v); 
      if (!v) {
        reset();
      } else if (!screenshot) {
        await handleCapture();
      }
    }}>
      <PopoverTrigger asChild>
        <button
          id="bug-report-trigger"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-slate-300 shadow-lg hover:bg-slate-700 hover:text-white transition-all hover:scale-105"
          title="Report a bug or suggestion"
        >
          <Bug className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Report Issue</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 sm:w-96 p-0 border-slate-700 bg-slate-900"
      >
        {sent ? (
          <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
            <div className="h-12 w-12 rounded-full bg-green-500/20 flex items-center justify-center mb-3">
              <Send className="h-5 w-5 text-green-400" />
            </div>
            <p className="font-medium text-white">Submitted!</p>
            <p className="text-xs text-slate-400 mt-1">Thanks for your feedback.</p>
          </div>
        ) : (
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm text-white">Report Issue / Suggestion</h4>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-300">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Type toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => setType("bug")}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                  type === "bug"
                    ? "bg-red-500/20 text-red-400 border border-red-500/40"
                    : "bg-slate-800 text-slate-400 border border-slate-700 hover:text-slate-300"
                }`}
              >
                <Bug className="h-3.5 w-3.5" />
                Bug Report
              </button>
              <button
                onClick={() => setType("suggestion")}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                  type === "suggestion"
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/40"
                    : "bg-slate-800 text-slate-400 border border-slate-700 hover:text-slate-300"
                }`}
              >
                <Lightbulb className="h-3.5 w-3.5" />
                Suggestion
              </button>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">Subject</Label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={type === "bug" ? "What went wrong?" : "What could be better?"}
                className="h-8 text-sm bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  type === "bug"
                    ? "Steps to reproduce, what you expected, what happened instead..."
                    : "Describe your idea..."
                }
                rows={3}
                className="text-sm bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 resize-none"
              />
            </div>

            {/* Screenshot Preview */}
            <div className="space-y-1.5 pt-1">
              <Label className="text-xs text-slate-400 flex items-center justify-between">
                Visual Context
                {screenshot && (
                  <button onClick={handleCapture} className="text-[10px] text-blue-400 hover:underline">
                    Retake
                  </button>
                )}
              </Label>
              <div className="relative aspect-video w-full rounded-md border border-slate-700 bg-slate-950 overflow-hidden group">
                {isCapturing ? (
                  <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">
                    <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                    Capturing screen...
                  </div>
                ) : screenshot ? (
                  <Image 
                    src={screenshot} 
                    alt="Current view" 
                    fill 
                    className="object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-500">
                    No screenshot captured
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-[10px] text-slate-500">
                Page: {pathname}
              </span>
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={!subject.trim() || !description.trim() || sending}
                className="h-7 text-xs gap-1.5"
              >
                {sending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                Submit
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
