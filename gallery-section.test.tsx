// Tests that GallerySection renders its error state when /api/gallery-assets fails,
// instead of falling through to the "No assets available" empty state.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import GallerySection from './src/components/sections/gallery-section';

// The component uses the classic JSX runtime, so React must be in global scope at render time.
(global as any).React = React;

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: any) => <img {...props} />,
}));

const okResponse = (items: any[]) =>
  ({ ok: true, json: async () => ({ items }) } as any);

describe('GallerySection', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.resetAllMocks();
  });

  it('renders the error state instead of the empty state when the fetch fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('HTTP 500'));
    render(<GallerySection />);
    await waitFor(() => {
      expect(screen.getByText(/Could not load the gallery\./)).toBeInTheDocument();
    });
    expect(screen.queryByText('No assets available.')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading gallery...')).not.toBeInTheDocument();
  });

  it('includes the fetch failure reason in the error message', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });
    render(<GallerySection />);
    await waitFor(() => {
      expect(screen.getByText(/Could not load the gallery\./)).toBeInTheDocument();
    });
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    expect(screen.queryByText('No assets available.')).not.toBeInTheDocument();
  });

  it('keeps the empty state when loading finishes with no error and no items', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(okResponse([]));
    render(<GallerySection />);
    await waitFor(() => {
      expect(screen.getByText('No assets available.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Could not load the gallery\./)).not.toBeInTheDocument();
  });

  it('renders fetched items with neither the empty nor the error state', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      okResponse([{ id: '1', title: 'Satellite One', assetUrl: '/models/one.glb', thumbnailUrl: null }])
    );
    render(<GallerySection />);
    await waitFor(() => {
      expect(screen.getByText('Satellite One')).toBeInTheDocument();
    });
    expect(screen.queryByText('No assets available.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load the gallery\./)).not.toBeInTheDocument();
  });
});
