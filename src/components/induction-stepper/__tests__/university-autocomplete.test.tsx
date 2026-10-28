/**
 * UniversityAutocomplete — induction Step 1 university picker.
 *
 * Regression (2026-10-28, reevaluation round): applicants on mobile and
 * laptop could not select a university. The component relied solely on
 * cmdk's onSelect, which this codebase's audit P3 already proved drops
 * real mouse clicks on rows (the F2 fix added an onClick fallback beside
 * onSelect in UserSelectionCombobox, src/components/admin/
 * user-selection-combobox.tsx). This picker never received that fix.
 *
 * Pins:
 *  - the options from useUniversities render when the popover opens;
 *  - a click on a row stores the value in form state and the required
 *    validation then accepts it;
 *  - a Class A source pin that the CommandItem carries the onClick
 *    fallback beside onSelect (jsdom cannot reproduce the browser
 *    click-drop, so the behavior test alone cannot pin the fix);
 *  - search filtering, and the graceful path when the options source
 *    is empty: typing a name offers Add, which stores the typed value.
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useForm, FormProvider } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import UniversityAutocomplete from '../UniversityAutocomplete';

const mockAddUniversity = jest.fn(async (_name: string) => {});
let mockUniversities: string[] = ['FAST-NUCES', 'Institute of Space Technology', 'NUST'];
let mockLoading = false;

jest.mock('@/hooks/use-universities', () => ({
  useUniversities: () => ({
    universities: mockUniversities,
    loading: mockLoading,
    error: null,
    addUniversity: mockAddUniversity,
  }),
}));

const schema = z.object({ university: z.string().min(1, 'University is required') });
let formMethods: any = null;

function Harness() {
  const methods = useForm({ resolver: zodResolver(schema), defaultValues: { university: '' } });
  formMethods = methods;
  return (
    <FormProvider {...methods}>
      <UniversityAutocomplete name="university" placeholder="University" />
      <output data-testid="value">{methods.watch('university')}</output>
    </FormProvider>
  );
}

beforeAll(() => {
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
  mockUniversities = ['FAST-NUCES', 'Institute of Space Technology', 'NUST'];
  mockLoading = false;
  mockAddUniversity.mockClear();
  formMethods = null;
});

afterEach(() => cleanup());

describe('UniversityAutocomplete', () => {
  it('renders the options from the universities source when opened', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByText('Institute of Space Technology')).toBeInTheDocument();
    expect(screen.getByText('FAST-NUCES')).toBeInTheDocument();
    expect(screen.getByText('NUST')).toBeInTheDocument();
  });

  it('a click on a row stores the value and required validation accepts it', async () => {
    render(<Harness />);
    // Required validation rejects the empty value before selection.
    expect(await formMethods.trigger('university')).toBe(false);

    fireEvent.click(screen.getByRole('combobox'));
    const row = await screen.findByText('Institute of Space Technology');
    fireEvent.click(row);

    await waitFor(() =>
      expect(screen.getByTestId('value').textContent).toBe('Institute of Space Technology')
    );
    expect(await formMethods.trigger('university')).toBe(true);
    // Popover closed after selection: the other options are gone.
    await waitFor(() => expect(screen.queryByText('FAST-NUCES')).not.toBeInTheDocument());
  });

  it('carries the audit-P3 onClick fallback beside cmdk onSelect (source pin)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'UniversityAutocomplete.tsx'), 'utf8');
    const itemBlock = source.slice(source.indexOf('<CommandItem'), source.indexOf('</CommandItem>'));
    expect(itemBlock).toContain('onSelect={() => handleSelect(uni)}');
    expect(itemBlock).toMatch(/onClick=\{\(\) => \{[\s\S]*?handleSelect\(uni\)/);
  });

  it('filters options by the search text', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox'));
    const input = await screen.findByPlaceholderText('Search university...');
    fireEvent.change(input, { target: { value: 'space' } });
    expect(await screen.findByText('Institute of Space Technology')).toBeInTheDocument();
    expect(screen.queryByText('FAST-NUCES')).not.toBeInTheDocument();
  });

  it('empty source still lets the applicant enter a university via Add', async () => {
    mockUniversities = [];
    render(<Harness />);
    fireEvent.click(screen.getByRole('combobox'));
    const input = await screen.findByPlaceholderText('Search university...');
    fireEvent.change(input, { target: { value: 'Namal University' } });
    const addButton = await screen.findByRole('button', { name: /Add "Namal University"/ });
    fireEvent.click(addButton);
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('Namal University'));
    expect(mockAddUniversity).toHaveBeenCalledWith('Namal University');
    expect(await formMethods.trigger('university')).toBe(true);
  });
});
