/**
 * WS1-4 regression tests: WebGL fallback for the "Our Impact in Action" 3D gallery.
 * WebGL is mocked as unsupported, so the component must render the static
 * SVG/PNG fallback instead of attempting a WebGL canvas.
 */
import React from 'react';
import fs from 'fs';
import path from 'path';

jest.mock('@react-three/fiber', () => ({
  Canvas: () => null,
  useFrame: () => {},
  useThree: () => ({ viewport: { aspect: 1, width: 10 } }),
}));
jest.mock('@react-three/drei', () => ({
  Image: () => null,
  Text: () => null,
  Preload: () => null,
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@/lib/webgl-utils', () => ({
  isWebGLSupported: () => false,
}));

import { render, screen, act } from '@testing-library/react';
import { PortalCanvas } from '../portal-canvas';

const ITEMS = [
  { id: 'f1', title: 'CubeSat Development', slug: 'cubesat', image: '/img-a.jpg', tag: 'projects' },
  { id: 'f2', title: 'School Outreach', slug: 'outreach', image: '/img-b.jpg', tag: 'outreach' },
];

describe('PortalCanvas WebGL gate (unsupported device)', () => {
  test('renders the static fallback instead of a WebGL canvas', async () => {
    await act(async () => {
      render(<PortalCanvas projects={ITEMS} />);
    });
    expect(screen.getByTestId('portal-static-fallback')).toBeInTheDocument();
    expect(screen.getByAltText('CubeSat Development')).toBeInTheDocument();
  });

  test('static fallback keeps the SVG orbit illustration and per-card labels', async () => {
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<PortalCanvas projects={ITEMS} />));
    });
    expect(container.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('PROJECTS')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /static view/i })).toBeInTheDocument();
  });

  test('empty project list renders nothing (no empty fallback container)', async () => {
    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<PortalCanvas projects={[]} />));
    });
    expect(container.querySelector('[data-testid="portal-static-fallback"]')).toBeNull();
  });
});

describe('WS1 trust-bar and admin telemetry regression guards', () => {
  const trustBarSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'sections', 'trust-bar.tsx'),
    'utf8'
  );
  const adminSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'app', 'admin', 'page.tsx'),
    'utf8'
  );
  const vercelSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'vercel.json'),
    'utf8'
  );

  test('public trust bar no longer links to the admin editor', () => {
    expect(trustBarSrc).not.toMatch(/Edit These Numbers/);
    expect(trustBarSrc).not.toMatch(/\/admin\/site-settings/);
  });

  test('admin MetricCard uses a stacked flex-column header with relaxed line-height', () => {
    expect(adminSrc).toMatch(/flex-col gap-2/);
    expect(adminSrc).toMatch(/leading-\[1\.4\]/);
  });

  test('vercel.json has no catch-all SPA rewrite that would shadow Next.js routes', () => {
    expect(vercelSrc).not.toMatch(/\/index\.html/);
    const parsed = JSON.parse(vercelSrc);
    expect(Array.isArray(parsed.rewrites)).toBe(true);
    expect(parsed.rewrites.every((r: any) => String(r.source).startsWith('/__/auth'))).toBe(true);
  });
});
