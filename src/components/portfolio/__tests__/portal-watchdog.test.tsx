/**
 * Regression tests for the blank 3D showcase: every card texture plus the
 * troika font sit behind one <Suspense fallback={null}>, so a single HUNG
 * fetch (dead image host, blocked CDN) suspended the gallery forever —
 * canvas present but empty, nothing thrown, fallback unreachable.
 *
 * Covered here:
 *  - the content-ready watchdog flips to the static fallback when the
 *    in-Suspense probe never mounts (Preload mocked as a hung load);
 *  - the watchdog does NOT flip when the probe signals ready in time;
 *  - the static fallback's <img> swaps a broken src to /assets/logo.png
 *    exactly once.
 */
import React from 'react';

let mockPreloadSuspends = false;

jest.mock('@react-three/fiber', () => {
  const ReactActual = require('react');
  return {
    Canvas: ({ children }: any) =>
      ReactActual.createElement(
        'div',
        { 'data-testid': 'r3f-canvas' },
        ReactActual.createElement('canvas'),
        children
      ),
    useFrame: () => {},
    useThree: () => ({ viewport: { aspect: 1.6, width: 10 } }),
  };
});
jest.mock('@react-three/drei', () => ({
  Image: () => null,
  Text: () => null,
  Preload: () => {
    if (mockPreloadSuspends) {
      // A hung asset load: a promise that never settles.
      throw new Promise(() => {});
    }
    return null;
  },
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@/lib/webgl-utils', () => ({
  isWebGLSupported: () => true,
}));

import { render, screen, act, fireEvent } from '@testing-library/react';
import { PortalCanvas, PortalStaticFallback } from '../portal-canvas';

const ITEMS = [
  { id: 'f1', title: 'CubeSat Development', slug: 'cubesat', image: '/img-a.jpg', tag: 'projects' },
  { id: 'f2', title: 'School Outreach', slug: 'outreach', image: '/img-b.jpg', tag: 'outreach' },
];

describe('PortalCanvas content-ready watchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockPreloadSuspends = false;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('flips to the static fallback when content never signals ready', () => {
    mockPreloadSuspends = true;
    render(<PortalCanvas projects={ITEMS} />);

    // 3D branch mounted (canvas element exists, so the 1.5s canvas gate
    // cannot save us), but no static fallback yet.
    expect(screen.getByTestId('r3f-canvas')).toBeInTheDocument();
    expect(screen.queryByTestId('portal-static-fallback')).toBeNull();

    // Past the 4000ms watchdog deadline with the probe never mounted.
    act(() => {
      jest.advanceTimersByTime(4100);
    });

    expect(screen.getByTestId('portal-static-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('r3f-canvas')).toBeNull();
  });

  test('does not flip when the probe signals ready in time', () => {
    render(<PortalCanvas projects={ITEMS} />);

    expect(screen.getByTestId('r3f-canvas')).toBeInTheDocument();

    // Well past the watchdog deadline: content mounted immediately, so
    // the gallery must stay in the 3D view.
    act(() => {
      jest.advanceTimersByTime(10000);
    });

    expect(screen.queryByTestId('portal-static-fallback')).toBeNull();
    expect(screen.getByTestId('r3f-canvas')).toBeInTheDocument();
  });
});

describe('PortalStaticFallback image hardening', () => {
  const FALLBACK_ITEMS = [
    { id: 'f1', title: 'CubeSat Development', image: '/img-a.jpg', tags: ['PROJECTS'] },
    { id: 'f2', title: 'School Outreach', image: '/assets/logo.png', tags: ['OUTREACH'] },
  ];

  test('broken img src swaps to /assets/logo.png exactly once', () => {
    render(<PortalStaticFallback items={FALLBACK_ITEMS} />);
    const img = screen.getByAltText('CubeSat Development') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/img-a.jpg');

    fireEvent.error(img);
    expect(img.getAttribute('src')).toBe('/assets/logo.png');

    // The swap target erroring must not loop or change anything further.
    fireEvent.error(img);
    expect(img.getAttribute('src')).toBe('/assets/logo.png');
  });

  test('img already pointing at /assets/logo.png is left untouched on error', () => {
    render(<PortalStaticFallback items={FALLBACK_ITEMS} />);
    const img = screen.getByAltText('School Outreach') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/assets/logo.png');

    fireEvent.error(img);
    expect(img.getAttribute('src')).toBe('/assets/logo.png');
  });
});
