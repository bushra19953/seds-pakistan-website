/**
 * @jest-environment node
 *
 * SEC-RACE (audit item 11): the live checkout must SEND an
 * idempotency key. The orders writers dedupe on (buyer, key), but
 * the key only helps if the checkout mints one — and it must be
 * stable across retries of the SAME attempt: minted once when the
 * checkout form instance is created, never regenerated per click or
 * per submit. Static pins, following the WS10 static-pin pattern.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '../page.tsx'), 'utf8');

describe('checkout page idempotency key (SEC-RACE item 11)', () => {
  it('mints the key once into a ref at component scope', () => {
    expect(src).toContain('idempotencyKeyRef = useRef<string | null>(null)');
    expect(src).toContain('crypto.randomUUID()');
  });

  it('sends the key on the createOrder input', () => {
    expect(src).toContain('idempotencyKey: idempotencyKeyRef.current');
  });

  it('never regenerates the key inside handleSubmit (stable across retries)', () => {
    const mintIdx = src.indexOf('crypto.randomUUID()');
    const submitIdx = src.indexOf('const handleSubmit');
    expect(mintIdx).toBeGreaterThan(-1);
    expect(submitIdx).toBeGreaterThan(-1);
    expect(mintIdx).toBeLessThan(submitIdx);
    const submitBody = src.slice(submitIdx, src.indexOf('const result = await createOrder', submitIdx));
    expect(submitBody).not.toContain('randomUUID');
    expect(submitBody).not.toContain('idempotencyKeyRef.current =');
  });
});
