import { afterEach, expect, test } from 'bun:test';
import { chooseElement, verifyExpectation } from '../src/jev';

const originalFetch = globalThis.fetch;
const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
const originalToken = process.env.CLOUDFLARE_API_TOKEN;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
  if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = originalToken;
});

test('semantic decisions are typed and retain their evidence', async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
  process.env.CLOUDFLARE_API_TOKEN = 'test';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(String(_input)).toEndWith('/accounts/account/ai/run');
    expect(body.model).toBe('typesafe/jev');
    const answer = body.input.questions.target
      ? { model: 'jev-test', answers: { target: { type: 'choice', choice: 'e2', confidence: 0.96, probabilities: { e1: 0.03, e2: 0.96, none: 0.01 } } }, usage: { input_tokens: 42, output_tokens: 3 } }
      : { model: 'jev-test', answers: { satisfied: { type: 'noul', noul: 0.91 } } };
    return Response.json(answer);
  }) as unknown as typeof fetch;
  const decision = await chooseElement('Open products', { url: 'https://example.com', title: 'Example', text: 'Menu Products' }, [
    { id: 'e1', role: 'button', label: 'Menu' }, { id: 'e2', role: 'button', label: 'Products' },
  ]);
  expect(decision).toMatchObject({ choice: 'e2', confidence: 0.96, model: 'jev-test' });
  expect((await verifyExpectation('Products are visible', { url: 'https://example.com', title: 'Example', text: 'Products' })).probability).toBe(0.91);
});

test('semantic decisions require credentials and reject malformed responses', async () => {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  await expect(chooseElement('Open products', { url: '', title: '', text: '' }, [{ id: 'e1', role: 'button', label: 'Products' }])).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID');
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
  process.env.CLOUDFLARE_API_TOKEN = 'test';
  globalThis.fetch = (async () => Response.json({ answers: { target: { choice: 'invented' } } })) as unknown as typeof fetch;
  await expect(chooseElement('Open products', { url: '', title: '', text: '' }, [{ id: 'e1', role: 'button', label: 'Products' }])).rejects.toThrow('invalid click decision');
});
