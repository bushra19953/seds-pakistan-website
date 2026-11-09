/**
 * AdSlot contract tests.
 *
 * Founder ruling (2026-11-09): ads may run in blogs, but the society has
 * no AdSense account yet. Until the deployment carries BOTH the enable
 * flag and the publisher/unit ids, every placement must render literally
 * nothing — no placeholder, no reserved space. These tests pin that
 * dark-by-default contract and the exact env names that light it up.
 */

import React from 'react';
import { render } from '@testing-library/react';
import AdSlot from '../AdSlot';

const ENV_KEYS = [
  'NEXT_PUBLIC_ADS_ENABLED',
  'NEXT_PUBLIC_ADSENSE_CLIENT',
  'NEXT_PUBLIC_ADSENSE_SLOT_LIST',
  'NEXT_PUBLIC_ADSENSE_SLOT_POST_INTRO',
  'NEXT_PUBLIC_ADSENSE_SLOT_POST_MID',
  'NEXT_PUBLIC_ADSENSE_SLOT_POST_END',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('AdSlot', () => {
  it('renders nothing when no ad env is set (the current production state)', () => {
    for (const placement of ['list', 'post-intro', 'post-mid', 'post-end'] as const) {
      const { container } = render(<AdSlot placement={placement} />);
      expect(container).toBeEmptyDOMElement();
    }
  });

  it('renders nothing when the flag is on but the publisher id is missing', () => {
    process.env.NEXT_PUBLIC_ADS_ENABLED = '1';
    process.env.NEXT_PUBLIC_ADSENSE_SLOT_LIST = '1234567890';
    const { container } = render(<AdSlot placement="list" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the publisher id is set but the flag is off', () => {
    process.env.NEXT_PUBLIC_ADSENSE_CLIENT = 'ca-pub-0000000000000000';
    process.env.NEXT_PUBLIC_ADSENSE_SLOT_LIST = '1234567890';
    const { container } = render(<AdSlot placement="list" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a placement whose own unit id is missing', () => {
    process.env.NEXT_PUBLIC_ADS_ENABLED = '1';
    process.env.NEXT_PUBLIC_ADSENSE_CLIENT = 'ca-pub-0000000000000000';
    process.env.NEXT_PUBLIC_ADSENSE_SLOT_LIST = '1234567890';
    const { container } = render(<AdSlot placement="post-mid" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the ad unit when fully configured', () => {
    process.env.NEXT_PUBLIC_ADS_ENABLED = '1';
    process.env.NEXT_PUBLIC_ADSENSE_CLIENT = 'ca-pub-0000000000000000';
    process.env.NEXT_PUBLIC_ADSENSE_SLOT_POST_MID = '9876543210';
    const { container } = render(<AdSlot placement="post-mid" />);
    const ins = container.querySelector('ins.adsbygoogle');
    expect(ins).not.toBeNull();
    expect(ins?.getAttribute('data-ad-client')).toBe('ca-pub-0000000000000000');
    expect(ins?.getAttribute('data-ad-slot')).toBe('9876543210');
    expect(container.querySelector('[data-ad-placement="post-mid"]')).not.toBeNull();
  });
});
