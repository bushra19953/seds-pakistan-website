/**
 * @jest-environment node
 *
 * Tests for POST /api/ai/assistant
 * (src/app/api/ai/assistant/route.ts).
 *
 * The study assistant must route through the server Gemini key pool:
 *   (a) validation: 400 on missing message/topic and on invalid JSON;
 *   (b) default path uses the server pool: executeWithFailover receives
 *       undefined as the user key when no per-user key is supplied;
 *   (c) per-user key override is forwarded only when it looks like a real
 *       key, and it is never returned in any response payload;
 *   (d) 503 when neither a user key nor a server key is configured;
 *   (e) Gemini failures produce a 500 whose message is scrubbed of any key;
 *   (f) topic mode builds a study-guide prompt; chat history is truncated;
 *   (g) the model allowlist rejects unknown model names.
 *
 * No em dashes are used in this file.
 */

jest.mock('@/lib/ai/key-manager', () => ({
  executeWithFailover: jest.fn(),
}));

import { executeWithFailover } from '@/lib/ai/key-manager';
import {
  POST,
  GET,
  buildAssistantPrompt,
  scrubKey,
  hasServerKey,
} from '../route';

const mockFailover = executeWithFailover as jest.Mock;

const SERVER_KEY = 'test-server-key-value-for-jest';
const USER_KEY = 'test-user-key-value-for-jest';

function makeGenAI(captured: { prompt?: string; model?: string; systemInstruction?: string }, reply = 'study guide text') {
  return {
    getGenerativeModel: (opts: any) => {
      captured.model = opts?.model;
      captured.systemInstruction = opts?.systemInstruction;
      return {
        generateContent: async (prompt: string) => {
          captured.prompt = prompt;
          return { response: { text: () => reply } };
        },
      };
    },
  };
}

function makeRequest(body: unknown) {
  return { json: async () => body } as any;
}

async function readJson(res: Response) {
  return (await res.json()) as Record<string, any>;
}

describe('POST /api/ai/assistant', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('returns 400 when neither message nor topic is supplied', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toMatch(/message or topic/i);
  });

  test('returns 400 on invalid JSON', async () => {
    const res = await POST({ json: async () => { throw new Error('bad json'); } } as any);
    expect(res.status).toBe(400);
  });

  test('defaults to the server key pool when no per-user key is supplied', async () => {
    process.env.GEMINI_API_KEY = SERVER_KEY;
    const captured: { prompt?: string; model?: string; systemInstruction?: string } = {};
    mockFailover.mockImplementation(async (op: any, userKey?: string) => {
      expect(userKey).toBeUndefined();
      return op(makeGenAI(captured));
    });

    const res = await POST(makeRequest({ topic: 'Orbital Mechanics' }));
    expect(res.status).toBe(200);
    const data = await readJson(res);
    expect(data.success).toBe(true);
    expect(data.reply).toBe('study guide text');
    expect(captured.systemInstruction).toBeDefined();
  });

  test('forwards a valid per-user key override to the failover executor', async () => {
    const captured: { prompt?: string; model?: string } = {};
    mockFailover.mockImplementation(async (op: any, userKey?: string) => {
      expect(userKey).toBe(USER_KEY);
      return op(makeGenAI(captured));
    });

    const res = await POST(makeRequest({ message: 'What is a Hohmann transfer?', apiKey: USER_KEY }));
    expect(res.status).toBe(200);
    const data = await readJson(res);
    // The server key (and the override) must never appear in a response.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(USER_KEY);
    expect(serialized).not.toContain(SERVER_KEY);
    expect(data).not.toHaveProperty('apiKey');
  });

  test('ignores a stub-like per-user key and falls back to the server pool', async () => {
    process.env.GEMINI_API_KEY = SERVER_KEY;
    mockFailover.mockImplementation(async (op: any, userKey?: string) => {
      expect(userKey).toBeUndefined();
      return op(makeGenAI({}));
    });
    const res = await POST(makeRequest({ message: 'hello', apiKey: 'short' }));
    expect(res.status).toBe(200);
  });

  test('returns 503 when no user key and no server key are configured', async () => {
    delete process.env.GEMINI_API_KEY;
    for (let i = 1; i <= 10; i++) delete process.env[`GEMINI_API_KEY_${i}`];
    const res = await POST(makeRequest({ message: 'hello' }));
    expect(res.status).toBe(503);
  });

  test('scrubs a leaked key from the Gemini failure response', async () => {
    process.env.GEMINI_API_KEY = SERVER_KEY;
    mockFailover.mockRejectedValue(new Error(`request failed using ${USER_KEY} quota`));
    const res = await POST(makeRequest({ message: 'hello', apiKey: USER_KEY }));
    expect(res.status).toBe(500);
    const data = await readJson(res);
    expect(data.error).not.toContain(USER_KEY);
    expect(data.error).toContain('[redacted]');
  });

  test('topic mode builds a study-guide prompt', () => {
    const { prompt } = buildAssistantPrompt({ topic: 'CubeSats' });
    expect(prompt).toContain('CubeSats');
    expect(prompt).toMatch(/study guide/i);
  });

  test('chat history is included but truncated to the newest turns', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      content: `turn-${i}`,
    }));
    const { prompt } = buildAssistantPrompt({ message: 'continue', history });
    expect(prompt).toContain('turn-29');
    expect(prompt).not.toContain('turn-0');
    expect(prompt).not.toContain('turn-9');
  });

  test('unknown model names fall back to the default', () => {
    delete process.env.GEMINI_MODEL;
    const { model } = buildAssistantPrompt({ message: 'hi', model: 'gemini-pro-x' });
    expect(model).toBe('gemini-2.5-flash');
  });

  test('allowlisted models are honored', () => {
    const { model } = buildAssistantPrompt({ message: 'hi', model: 'gemini-2.5-flash-lite' });
    expect(model).toBe('gemini-2.5-flash-lite');
  });

  test('scrubKey leaves text without a real key untouched', () => {
    expect(scrubKey('plain error')).toBe('plain error');
    expect(scrubKey('err', 'short')).toBe('err');
  });

  test('hasServerKey reads env names only', () => {
    process.env.GEMINI_API_KEY = SERVER_KEY;
    expect(hasServerKey()).toBe(true);
    delete process.env.GEMINI_API_KEY;
    for (let i = 1; i <= 10; i++) delete process.env[`GEMINI_API_KEY_${i}`];
    expect(hasServerKey()).toBe(false);
  });

  test('GET reports server-key presence without exposing it', async () => {
    process.env.GEMINI_API_KEY = SERVER_KEY;
    const res = await GET();
    const data = await readJson(res);
    expect(data.ok).toBe(true);
    expect(data.serverKeyConfigured).toBe(true);
    expect(JSON.stringify(data)).not.toContain(SERVER_KEY);
  });
});
