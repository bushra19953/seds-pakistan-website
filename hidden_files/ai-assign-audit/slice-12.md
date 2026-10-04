## Slice 12/20 DONE — Gemini key path

- Per-user key from localStorage 'gemini.apiKey' (task-form.tsx:510), sent as apiKey (524). Server: executeWithFailover, user key >10 chars => used EXCLUSIVELY, no fallback (key-manager.ts:94-99).
- Missing/short key => silent fallback to server pool. Invalid-but-long key (400/403) => HARD FAIL, no fallback to pool; only remedy is clearing it in AI Settings.
- Key failures throw; never produce degraded assignment JSON. Wrong-assignee behavior is NOT a key defect — it's stale role data upstream (registry built client-side at task-form.tsx:527-528).
- Secondary: pool state in-memory per serverless instance; 429 cooldowns don't coordinate across Vercel instances.
