// Static Step 1 fields for the induction form (spec section 6.3, low-risk).
// These two OPTIONAL selects are hardcoded alongside the admin-configured
// dynamic fields. They are stored additively on the applications/{uid} doc
// as targetChapter and preferredTrack. They never touch role logic, the
// atomic submit batch shape, or the admin approval path.
//
// Value notes:
// - "ist" / "national_open_pool" are plain strings. "National Open Pool"
//   does not exist as a chapter doc yet (needs Zubair's decision); storing
//   the string is enough for now.
// - The track values are SubsystemTrack tokens (propulsion, structures,
//   avionics, robotics, materials) plus media_marketing, which is outside
//   the canonical SubsystemTrack enum and exists only as an application
//   preference for media, communications and B2B sponsorship applicants.

export interface StaticSelectOption {
  value: string;
  label: string;
}

export interface StaticStep1Field {
  id: string;
  name: 'targetChapter' | 'preferredTrack';
  label: string;
  type: 'select';
  required: boolean;
  step: number;
  order: number;
  description: string;
  options: StaticSelectOption[];
}

export const TARGET_CHAPTER_OPTIONS: StaticSelectOption[] = [
  { value: 'ist', label: 'Institute of Space Technology (IST)' },
  { value: 'national_open_pool', label: 'National Open Pool' },
];

export const PREFERRED_TRACK_OPTIONS: StaticSelectOption[] = [
  { value: 'propulsion', label: 'Propulsion' },
  { value: 'structures', label: 'Structures' },
  { value: 'avionics', label: 'Avionics' },
  { value: 'robotics', label: 'Robotics' },
  { value: 'materials', label: 'Materials' },
  { value: 'media_marketing', label: 'Media, Communications & B2B Sponsorship' },
];

export const STATIC_STEP1_FIELDS: StaticStep1Field[] = [
  {
    id: 'static_target_chapter',
    name: 'targetChapter',
    label: 'Target Chapter',
    type: 'select',
    required: false,
    step: 0,
    order: 900,
    description: 'Which chapter are you applying to join? Optional, you can decide later.',
    options: TARGET_CHAPTER_OPTIONS,
  },
  {
    id: 'static_preferred_track',
    name: 'preferredTrack',
    label: 'Preferred Track',
    type: 'select',
    required: false,
    step: 0,
    order: 901,
    description: 'Which technical track interests you most? Optional, you can change later.',
    options: PREFERRED_TRACK_OPTIONS,
  },
];

export function optionLabelFor(options: StaticSelectOption[], value: unknown): string {
  if (typeof value !== 'string' || value === '') return 'N/A';
  const found = options.find((o) => o.value === value);
  return found ? found.label : value;
}
