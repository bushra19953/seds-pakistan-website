/**
 * StepRolePicker (Custom Roles Fix Program, consumers item, Surface 1;
 * contracts.md Sections 4.2 and 4.3).
 *
 * The step Role field becomes a picker fed by ONE options source,
 * getUnifiedRoleOptions(firestore, uid, chapterId): catalog options as
 * today, plus the chapter's custom roles (active definitions only)
 * when a chapterId is passed. Custom options render their definition
 * title with the Custom marker; selecting one stores the SLUG. Free
 * text working titles stay possible through the creatable row, and
 * Clear empties the value. A stored custom slug displays as the
 * definition title on the trigger, never the raw slug.
 *
 * The mock below keys its return on the chapterId ARGUMENT: chapter
 * exclusion is the options source's job under contracts, so these
 * tests prove the picker passes its chapter through and renders what
 * the source returns for that chapter - no more, no less.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/firebase', () => ({
  useFirestore: () => ({}),
  useUser: () => ({ user: { uid: 'admin-1' } }),
}));

const CATALOG_OPTS = [
  { key: 'chapter_design_chair', label: 'Chapter Design and Media Chair (chapter_design_chair)' },
  { key: 'chapter_events_chair', label: 'Chapter Events Chair (chapter_events_chair)' },
];
const IST_CUSTOM = { key: 'custom_poster_team_lead', label: 'Poster Squad Lead (custom_poster_team_lead)' };
const LHR_CUSTOM = { key: 'custom_media_lead', label: 'Lahore Media Lead (custom_media_lead)' };

jest.mock('@/lib/unified-roles', () => ({
  getUnifiedRoleOptions: jest.fn(async (_fs: any, _uid?: string, chapterId?: string) => {
    if (chapterId === 'seds-ist-chapter') return [...CATALOG_OPTS, IST_CUSTOM];
    if (chapterId === 'seds-lahore-chapter') return [...CATALOG_OPTS, LHR_CUSTOM];
    if (chapterId === 'seds-empty-chapter') return [...CATALOG_OPTS];
    return [...CATALOG_OPTS, IST_CUSTOM, LHR_CUSTOM];
  }),
  normalizeRoleSlug: (s: string) =>
    String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
  FOUNDER_UID: 'founder-uid',
}));

import { StepRolePicker } from '@/components/admin/tasks/step-role-picker';
import { getUnifiedRoleOptions } from '@/lib/unified-roles';

const mockOptions = getUnifiedRoleOptions as jest.Mock;

beforeAll(() => {
  // Shims Radix Popover and cmdk expect from a real browser (same set
  // as the chapter-selector suite).
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
  Element.prototype.scrollIntoView = jest.fn();
  (Element.prototype as any).hasPointerCapture = jest.fn(() => false);
  (Element.prototype as any).setPointerCapture = jest.fn();
  (Element.prototype as any).releasePointerCapture = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
});

async function openPicker(props: Record<string, any> = {}) {
  const onChange = jest.fn();
  const utils = render(
    <StepRolePicker id="step-role-0" value="" onChange={onChange} {...props} />
  );
  const trigger = screen.getByRole('button', { name: /step role/i });
  fireEvent.click(trigger);
  // A catalog option is the canary that options loaded.
  await screen.findByText(/Chapter Events Chair \(chapter_events_chair\)/);
  return { onChange, ...utils };
}

describe('StepRolePicker (Surface 1)', () => {
  it('renders catalog options from getUnifiedRoleOptions', async () => {
    await openPicker({ chapterId: 'seds-ist-chapter' });
    expect(screen.getByText(/Chapter Design and Media Chair \(chapter_design_chair\)/)).toBeInTheDocument();
    expect(screen.getByText(/Chapter Events Chair \(chapter_events_chair\)/)).toBeInTheDocument();
  });

  it('passes the chapter through and renders only that chapter\u2019s custom roles, each with the marker; selecting one stores the slug', async () => {
    const { onChange } = await openPicker({ chapterId: 'seds-ist-chapter' });
    expect(mockOptions).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'seds-ist-chapter');
    const customRow = screen.getByText(/Poster Squad Lead \(custom_poster_team_lead\)/);
    expect(customRow).toBeInTheDocument();
    expect(screen.queryByText(/Lahore Media Lead/)).toBeNull();
    // The marker rides on the custom row (shared fixture text).
    const row = customRow.closest('[cmdk-item]') || customRow.parentElement;
    expect(row?.textContent).toContain('Custom');
    fireEvent.click(customRow);
    expect(onChange).toHaveBeenCalledWith('custom_poster_team_lead');
  });

  it('with no chapter selected, custom roles from all chapters appear', async () => {
    await openPicker({ chapterId: undefined });
    expect(screen.getByText(/Poster Squad Lead \(custom_poster_team_lead\)/)).toBeInTheDocument();
    expect(screen.getByText(/Lahore Media Lead \(custom_media_lead\)/)).toBeInTheDocument();
  });

  it('an empty chapter custom list renders the honest empty row', async () => {
    await openPicker({ chapterId: 'seds-empty-chapter' });
    expect(screen.getByText('No custom roles in this chapter')).toBeInTheDocument();
  });

  it('typing a non-option text offers the creatable row and stores the verbatim text; Clear empties the value', async () => {
    const { onChange } = await openPicker({ chapterId: 'seds-ist-chapter' });
    const input = screen.getByPlaceholderText(/search/i) || document.querySelector('[cmdk-input]');
    expect(input).not.toBeNull();
    fireEvent.change(input as Element, { target: { value: 'Lead Message Auditor' } });
    const creatable = await screen.findByText(/Use as working title: "Lead Message Auditor"/);
    fireEvent.click(creatable);
    expect(onChange).toHaveBeenCalledWith('Lead Message Auditor');
  });

  it('Clear empties a stored value', async () => {
    const { onChange } = await openPicker({ chapterId: 'seds-ist-chapter', value: 'chapter_events_chair' });
    fireEvent.click(screen.getByText(/Clear role/i));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('a stored custom slug displays the definition title and marker on the trigger, never the slug', async () => {
    render(
      <StepRolePicker id="step-role-0" value="custom_poster_team_lead" chapterId="seds-ist-chapter" onChange={jest.fn()} />
    );
    const trigger = await screen.findByRole('button', { name: /step role/i });
    // Options load async; the trigger settles on the definition title.
    await screen.findByText('Poster Squad Lead');
    expect(trigger.textContent).toContain('Poster Squad Lead');
    expect(trigger.textContent).toContain('Custom');
    expect(trigger.textContent).not.toContain('custom_poster_team_lead');
  });
});
