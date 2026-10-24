import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import BlogPostForm, {
  BlogPostFormValues,
  parseComponentJsonFields,
  componentJsonTextsFromInitialData,
} from '@/components/admin/blog/blog-post-form';

// Schema-valid component data used across the suite.
const launchReadiness: NonNullable<BlogPostFormValues['launchReadiness']> = {
  verificationMetrics: [{ label: 'Avionics check', value: 'Complete', verified: true }],
};
const dataShowcase: NonNullable<BlogPostFormValues['dataShowcase']> = {
  technicalSpecs: [{ label: 'Thrust', value: '1200', status: 'nominal', unit: 'N' }],
  engineeringSeal: {
    certifiedBy: 'SEDS Review Board',
    certificationLevel: 'Internal review',
    validatedDate: '2026-10-01',
  },
};
const analogArchive: NonNullable<BlogPostFormValues['analogArchive']> = {
  documents: [
    {
      id: 'doc-1',
      title: 'Test Log',
      description: 'Hot-fire test log',
      imageUrl: '/images/test.jpg',
      date: '2026-09-15',
      author: 'Propulsion Team',
      tags: ['test'],
      category: 'test',
    },
  ],
};
const futureHorizons: NonNullable<BlogPostFormValues['futureHorizons']> = {
  horizons: [
    {
      id: 'h-1',
      title: 'Certification',
      description: 'High-power certification',
      timeline: '2027',
      impact: 'transformative',
      category: 'research',
      progress: 40,
    },
  ],
};

const emptyTexts = {
  launchReadiness: '',
  dataShowcase: '',
  analogArchive: '',
  futureHorizons: '',
};

describe('parseComponentJsonFields', () => {
  it('parses valid JSON in each box into values under the right key', () => {
    const { values, errors } = parseComponentJsonFields({
      launchReadiness: JSON.stringify(launchReadiness),
      dataShowcase: JSON.stringify(dataShowcase),
      analogArchive: JSON.stringify(analogArchive),
      futureHorizons: JSON.stringify(futureHorizons),
    });
    expect(errors).toEqual({});
    expect(values.launchReadiness).toEqual(launchReadiness);
    expect(values.dataShowcase).toEqual(dataShowcase);
    expect(values.analogArchive).toEqual(analogArchive);
    expect(values.futureHorizons).toEqual(futureHorizons);
  });

  it('reports a field-level error for invalid JSON and keeps other boxes', () => {
    const { values, errors } = parseComponentJsonFields({
      ...emptyTexts,
      launchReadiness: JSON.stringify(launchReadiness),
      dataShowcase: '{not json',
    });
    expect(values.launchReadiness).toEqual(launchReadiness);
    expect(values.dataShowcase).toBeUndefined();
    expect(errors.dataShowcase).toMatch(/Invalid JSON/);
    expect(errors.launchReadiness).toBeUndefined();
  });

  it('reports a field-level error when valid JSON does not match the expected shape', () => {
    const { values, errors } = parseComponentJsonFields({
      ...emptyTexts,
      futureHorizons: JSON.stringify({ horizons: [{ id: 'x' }] }),
    });
    expect(values.futureHorizons).toBeUndefined();
    expect(errors.futureHorizons).toMatch(/expected format/);
  });

  it('treats empty and whitespace-only boxes as absent fields, with no error', () => {
    const { values, errors } = parseComponentJsonFields({
      launchReadiness: '',
      dataShowcase: '   ',
      analogArchive: '\n\t',
      futureHorizons: '',
    });
    expect(values).toEqual({});
    expect(errors).toEqual({});
  });
});

describe('componentJsonTextsFromInitialData', () => {
  it('stringifies stored component data for edit prefill and leaves missing blocks empty', () => {
    const texts = componentJsonTextsFromInitialData({ launchReadiness, futureHorizons });
    expect(JSON.parse(texts.launchReadiness)).toEqual(launchReadiness);
    expect(JSON.parse(texts.futureHorizons)).toEqual(futureHorizons);
    expect(texts.dataShowcase).toBe('');
    expect(texts.analogArchive).toBe('');
  });
});

function renderForm(props: Partial<React.ComponentProps<typeof BlogPostForm>> = {}) {
  const onSubmit = jest.fn();
  render(<BlogPostForm onSubmit={onSubmit} submitLabel="Save Post" {...props} />);
  return { onSubmit };
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'A Real Post Title' },
  });
  fireEvent.change(screen.getByLabelText('Body'), {
    target: { value: 'This body is long enough to pass validation.' },
  });
}

function clickSave() {
  fireEvent.click(screen.getByRole('button', { name: 'Save Post' }));
}

describe('BlogPostForm Advanced Component Data wiring', () => {
  it('submits typed JSON under the structured keys and omits untouched boxes', async () => {
    const { onSubmit } = renderForm();
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText('Launch Readiness Metrics (JSON)'), {
      target: { value: JSON.stringify(launchReadiness) },
    });
    fireEvent.change(screen.getByLabelText('Future Horizons (JSON)'), {
      target: { value: JSON.stringify(futureHorizons) },
    });
    clickSave();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as BlogPostFormValues;
    expect(submitted.launchReadiness).toEqual(launchReadiness);
    expect(submitted.futureHorizons).toEqual(futureHorizons);
    expect(submitted).not.toHaveProperty('dataShowcase');
    expect(submitted).not.toHaveProperty('analogArchive');
  });

  it('blocks submit and shows a field error when a box holds invalid JSON', async () => {
    const { onSubmit } = renderForm();
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText('Data Showcase (JSON)'), {
      target: { value: '{broken json' },
    });
    clickSave();

    expect(await screen.findByText(/Invalid JSON/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits with all four keys absent when every box is empty', async () => {
    const { onSubmit } = renderForm();
    fillRequiredFields();
    clickSave();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as BlogPostFormValues;
    expect(submitted).not.toHaveProperty('launchReadiness');
    expect(submitted).not.toHaveProperty('dataShowcase');
    expect(submitted).not.toHaveProperty('analogArchive');
    expect(submitted).not.toHaveProperty('futureHorizons');
  });

  it('prefills the boxes from stored data on edit and round-trips them unchanged', async () => {
    const initialData: Partial<BlogPostFormValues> = {
      title: 'Existing Post',
      body: 'Existing body content, long enough.',
      status: 'draft',
      launchReadiness,
      dataShowcase,
      analogArchive,
      futureHorizons,
    };
    const { onSubmit } = renderForm({ initialData });

    const launchBox = screen.getByLabelText('Launch Readiness Metrics (JSON)') as HTMLTextAreaElement;
    const showcaseBox = screen.getByLabelText('Data Showcase (JSON)') as HTMLTextAreaElement;
    const archiveBox = screen.getByLabelText('Analog Archive Documents (JSON)') as HTMLTextAreaElement;
    const horizonsBox = screen.getByLabelText('Future Horizons (JSON)') as HTMLTextAreaElement;
    expect(JSON.parse(launchBox.value)).toEqual(launchReadiness);
    expect(JSON.parse(showcaseBox.value)).toEqual(dataShowcase);
    expect(JSON.parse(archiveBox.value)).toEqual(analogArchive);
    expect(JSON.parse(horizonsBox.value)).toEqual(futureHorizons);

    clickSave();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as BlogPostFormValues;
    expect(submitted.launchReadiness).toEqual(launchReadiness);
    expect(submitted.dataShowcase).toEqual(dataShowcase);
    expect(submitted.analogArchive).toEqual(analogArchive);
    expect(submitted.futureHorizons).toEqual(futureHorizons);
  });
});

describe('BlogPostForm placeholder hygiene', () => {
  it('uses neutral author-profile placeholders with no fictional person or employer', () => {
    renderForm();
    expect(screen.getByLabelText('Author Name')).toHaveAttribute(
      'placeholder',
      'Full name of the author',
    );
    expect(screen.getByLabelText('Location')).toHaveAttribute('placeholder', 'City, institution');
    expect(screen.getByLabelText(/Achievements/)).toHaveAttribute(
      'placeholder',
      "Comma-separated list of the author's achievements",
    );
    expect(screen.getByLabelText(/Credentials/)).toHaveAttribute(
      'placeholder',
      "Comma-separated list of the author's credentials",
    );
  });
});
