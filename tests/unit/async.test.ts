import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../../src/engine/async.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withTimeout：可选增强类调用的安全网', () => {
  it('未超时时返回真实结果', async () => {
    const value = await withTimeout(Promise.resolve('ok'), 100);
    assert.equal(value, 'ok');
  });

  it('超时时返回 null（而不是抛错）', async () => {
    const slow = sleep(200).then(() => 'late');
    const value = await withTimeout(slow, 30);
    assert.equal(value, null);
  });

  it('被拒绝的 Promise 也退化为 null（回填失败不该影响主流程）', async () => {
    const value = await withTimeout(Promise.reject(new Error('boom')), 100);
    assert.equal(value, null);
  });

  it('已有结果时不会因为后续超时而改变返回值', async () => {
    const value = await withTimeout(Promise.resolve(42), 50);
    await sleep(80); // wait past the timeout
    assert.equal(value, 42);
  });
});
