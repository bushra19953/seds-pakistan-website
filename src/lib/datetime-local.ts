// Helper: convert an ISO datetime to an input[type="datetime-local"] string in
// the browser's local time, so dialog prefills render true local wall clock
// instead of raw UTC.
//
// This lives in its own leaf module on purpose: it used to be defined inside
// src/components/admin/tasks/task-form.tsx, and every consumer that imported
// this one small helper (the admin tasks page, the authority inspector, the
// workflow deadline button) pulled the entire 2,200-line task form —
// including @dnd-kit — into its route bundle, defeating the form's own
// next/dynamic split. Import it from here instead.
export function toDatetimeLocal(iso?: string): string {
  if (!iso || typeof iso !== 'string') return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}
