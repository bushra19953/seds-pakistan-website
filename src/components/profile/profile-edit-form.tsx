"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

type Chapter = { id: string; name: string };

type ProfileEditFormProps = {
  initialForm: any;
  onGetValuesRef?: (getValues: () => any) => void;
  chapters: Chapter[];
};

function ProfileEditFormImpl({ initialForm, onGetValuesRef, chapters }: ProfileEditFormProps) {
  const [form, setForm] = React.useState<any>(initialForm || {});
  const refs = React.useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  const activeFieldNameRef = React.useRef<string | null>(null);
  const caretStartRef = React.useRef<number | null>(null);
  const caretEndRef = React.useRef<number | null>(null);
  const composingRef = React.useRef<boolean>(false);

  React.useLayoutEffect(() => {
    const name = activeFieldNameRef.current;
    if (!name) return;
    let el = refs.current[name] as any;
    if (!el && typeof document !== 'undefined') {
      el = document.getElementById(name) as any;
      if (el) refs.current[name] = el;
    }
    if (!el) return;
    if (composingRef.current) return;
    try {
      el.focus();
      const start = caretStartRef.current;
      const end = caretEndRef.current;
      if (typeof el.setSelectionRange === "function" && start != null && end != null) {
        el.setSelectionRange(start, end);
      }
    } catch { }
  }, [form]);

  const set = React.useCallback(
    (patch: Partial<any>) => {
      setForm((prev: any) => ({ ...prev, ...patch }));
    },
    []
  );

  React.useEffect(() => {
    if (onGetValuesRef) {
      onGetValuesRef(() => form);
    }
  }, [form, onGetValuesRef]);

  const captureCaret = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    try {
      caretStartRef.current = (e.target as any).selectionStart ?? null;
      caretEndRef.current = (e.target as any).selectionEnd ?? null;
    } catch {
      caretStartRef.current = null;
      caretEndRef.current = null;
    }
  };

  const onFocusTrack = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const id = e.currentTarget.id || e.currentTarget.getAttribute('name') || '';
    if (id) {
      refs.current[id] = e.currentTarget as any;
      activeFieldNameRef.current = id;
    }
    captureCaret({ target: e.currentTarget } as any);
  };

  const onSelectTrack = (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const target = e.currentTarget as any;
    try {
      caretStartRef.current = target.selectionStart ?? null;
      caretEndRef.current = target.selectionEnd ?? null;
    } catch { }
  };

  return (
    <div className="space-y-3">
      <Input
        placeholder="Full name"
        id="profile.displayName"
        value={form.displayName || ""}
        onFocus={onFocusTrack}
        onSelect={onSelectTrack}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onChange={(e) => { captureCaret(e); set({ displayName: e.target.value }); }}
      />
      <Textarea
        placeholder="Bio"
        id="profile.bio"
        value={form.bio || ""}
        onFocus={onFocusTrack}
        onSelect={onSelectTrack}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onChange={(e) => { captureCaret(e as any); set({ bio: (e.target as any).value }); }}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input
          placeholder="GitHub URL"
          id="profile.githubUrl"
          value={form.githubUrl || ""}
          onFocus={onFocusTrack}
          onSelect={onSelectTrack}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onChange={(e) => { captureCaret(e); set({ githubUrl: e.target.value }); }}
        />
        <Input
          placeholder="LinkedIn URL"
          id="profile.linkedinUrl"
          value={form.linkedinUrl || ""}
          onFocus={onFocusTrack}
          onSelect={onSelectTrack}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onChange={(e) => { captureCaret(e); set({ linkedinUrl: e.target.value }); }}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Input
            placeholder="WhatsApp Number (Required)"
            id="profile.whatsapp"
            value={form.whatsapp || form.whatsappNumber || ""}
            onFocus={onFocusTrack}
            onSelect={onSelectTrack}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onChange={(e) => { captureCaret(e); set({ whatsapp: e.target.value, whatsappNumber: e.target.value }); }}
            className={(!form.whatsapp && !form.whatsappNumber) ? 'border-red-500/50' : ''}
          />
          <p className="text-[10px] text-muted-foreground px-1">
            * Visible only to admins and mission teammates.
          </p>
        </div>
        <Input
          placeholder="Field of Study"
          id="profile.fieldOfStudy"
          value={form.fieldOfStudy || ""}
          onFocus={onFocusTrack}
          onSelect={onSelectTrack}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onChange={(e) => { captureCaret(e); set({ fieldOfStudy: e.target.value }); }}
        />
      </div>
      <Input
        placeholder="University"
        id="profile.university"
        value={form.university || ""}
        onFocus={onFocusTrack}
        onSelect={onSelectTrack}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onChange={(e) => { captureCaret(e); set({ university: e.target.value }); }}
      />
      <Select value={form.chapterId || ""} onValueChange={(v) => set({ chapterId: v })}>
        <SelectTrigger className="w-full"><SelectValue placeholder="Select Chapter" /></SelectTrigger>
        <SelectContent>
          {chapters.map((c) => (
            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export const ProfileEditForm = React.memo(ProfileEditFormImpl);

export default ProfileEditForm;
