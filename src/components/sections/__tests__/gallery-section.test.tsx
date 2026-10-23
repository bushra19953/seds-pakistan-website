/**
 * GallerySection: the designed empty state renders when the gallery API
 * returns zero assets (the live state of the public 3D gallery), and the
 * non-empty path still renders model cards. Fetch is mocked per test.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import GallerySection from '@/components/sections/gallery-section';

function mockFetchItems(items: unknown[]) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ items }),
  }) as jest.Mock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GallerySection', () => {
  it('renders the designed empty state when there are no assets', async () => {
    mockFetchItems([]);
    render(<GallerySection />);

    expect(await screen.findByText('No 3D models yet')).toBeTruthy();
    expect(screen.getByText(/preparing interactive models/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Explore our projects' });
    expect(link.getAttribute('href')).toBe('/projects');
    expect(screen.queryByText('No assets available.')).toBeNull();
  });

  it('renders model cards and no empty state when assets exist', async () => {
    mockFetchItems([
      {
        id: 'model-1',
        title: 'CubeSat Model',
        assetUrl: 'https://example.com/cubesat.glb',
        thumbnailUrl: null,
      },
    ]);
    render(<GallerySection />);

    expect(await screen.findByText('CubeSat Model')).toBeTruthy();
    expect(screen.queryByText('No 3D models yet')).toBeNull();
  });
});
