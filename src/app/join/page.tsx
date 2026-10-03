'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface FormState {
  fullName: string;
  email: string;
  whatsapp: string;
  university: string;
  department: string;
  graduationYear: string;
}

const EMPTY: FormState = {
  fullName: '',
  email: '',
  whatsapp: '',
  university: '',
  department: '',
  graduationYear: '',
};

const YEARS = ['2027', '2028', '2029', '2030', '2031', '2032'];

// Distraction-free squeeze page: no site header, no footer, no outbound links.
// Single purpose: capture verified student contact info in exchange for the
// Webots Autonomous Mars Rover Navigation Starter Codebase.
export default function JoinPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (Object.values(form).some((v) => !v.trim())) {
      setError('Please fill in all six fields.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/send-welcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Submission failed. Please try again.');
        setSubmitting(false);
        return;
      }
      router.push(`/join/confirmation?token=${encodeURIComponent(data.token)}`);
    } catch {
      setError('Network error. Please check your connection and try again.');
      setSubmitting(false);
    }
  }

  const inputCls =
    'w-full rounded-lg border border-slate-700 bg-slate-900/80 px-4 py-3 text-sm text-slate-100 placeholder:text-muted-foreground outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition';

  return (
    <main className="min-h-screen bg-[#020617] text-slate-100 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/80 shadow-2xl overflow-hidden">
          <div className="px-8 pt-10 pb-6 text-center border-b border-slate-800 bg-[radial-gradient(circle_at_top,#1e1b4b_0%,transparent_70%)]">
            <p className="text-xs font-bold tracking-[0.3em] text-emerald-400 uppercase mb-3">
              SEDS Pakistan
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold leading-tight">
              Get the Mars Rover Starter Codebase
            </h1>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
              Instant access to the Webots Autonomous Mars Rover Navigation
              Starter Codebase plus the official syllabus PDF. No spam, just
              mission-critical material.
            </p>
          </div>

          <form onSubmit={onSubmit} className="px-8 py-8 space-y-4">
            <div>
              <label htmlFor="fullName" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Full Name
              </label>
              <input
                id="fullName"
                type="text"
                value={form.fullName}
                onChange={set('fullName')}
                placeholder="Muhammad Ali"
                className={inputCls}
                autoComplete="name"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                University Email
              </label>
              <input
                id="email"
                type="email"
                value={form.email}
                onChange={set('email')}
                placeholder="you@university.edu.pk"
                className={inputCls}
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="whatsapp" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                WhatsApp Number (E.164)
              </label>
              <input
                id="whatsapp"
                type="tel"
                value={form.whatsapp}
                onChange={set('whatsapp')}
                placeholder="+923001234567"
                className={inputCls}
                autoComplete="tel"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Include your country code, e.g. +92 for Pakistan.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="university" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  University
                </label>
                <input
                  id="university"
                  type="text"
                  value={form.university}
                  onChange={set('university')}
                  placeholder="Institute of Space Technology"
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor="department" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Department
                </label>
                <input
                  id="department"
                  type="text"
                  value={form.department}
                  onChange={set('department')}
                  placeholder="Aerospace Engineering"
                  className={inputCls}
                />
              </div>
            </div>

            <div>
              <label htmlFor="graduationYear" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Expected Graduation Year
              </label>
              <select
                id="graduationYear"
                value={form.graduationYear}
                onChange={set('graduationYear')}
                className={inputCls}
              >
                <option value="">Select year</option>
                {YEARS.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300" role="alert">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-emerald-500 px-6 py-3.5 text-sm font-bold uppercase tracking-widest text-[#020617] hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed transition shadow-[0_4px_14px_rgba(16,185,129,0.4)]"
            >
              {submitting ? 'Transmitting...' : 'Send My Starter Pack'}
            </button>

            <p className="text-center text-[11px] text-muted-foreground">
              Your details are used only for SEDS Pakistan mission correspondence.
            </p>
          </form>
        </div>
      </div>
    </main>
  );
}
