/**
 * @jest-environment node
 *
 * client.test.ts — the Supabase client factory returns null (never throws)
 * when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing, so callers can
 * fall back to Firestore. The SDK is mocked; no live Supabase calls.
 */

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

import { createClient } from '@supabase/supabase-js';
import { getSupaClient, resetSupaClientForTests } from '@/lib/supa/client';

const createClientMock = createClient as unknown as jest.Mock;

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

describe('getSupaClient', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    createClientMock.mockReset();
    resetSupaClientForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetSupaClientForTests();
  });

  it('returns null when nothing is configured, without calling the SDK', () => {
    expect(getSupaClient()).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('returns null when only the URL is set', () => {
    process.env.SUPABASE_URL = 'https://proj.supabase.co';
    expect(getSupaClient()).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('returns null when only the key is set', () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    expect(getSupaClient()).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('builds a service client from the env and memoizes it', () => {
    const sentinel = { from: jest.fn() };
    createClientMock.mockReturnValue(sentinel);
    process.env.SUPABASE_URL = 'https://proj.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

    expect(getSupaClient()).toBe(sentinel);
    expect(getSupaClient()).toBe(sentinel);
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledWith(
      'https://proj.supabase.co',
      'service-key',
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  });
});
