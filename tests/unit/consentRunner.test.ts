import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSENT_INITIAL_DELAY_MS,
  CONSENT_MAX_ATTEMPTS,
  CONSENT_RETRY_THROTTLE_MS,
  createConsentController,
  type ConsentHit,
  type ConsentTimer,
} from '../../src/content/consent.ts';

// Runner invariants: one decision per page, a finite number of looks, and the gates stop it
// permanently. Timers are injected, so these tests never wait in real time.

type Pending = { fn: () => void; ms: number };

function fakeTimer(): {
  timer: ConsentTimer;
  pending: () => Pending | null;
  clearCount: () => number;
} {
  let pending: Pending | null = null;
  let cleared = 0;
  return {
    timer: {
      set(fn, ms) {
        pending = { fn, ms };
        return pending;
      },
      clear(handle) {
        if (pending !== null && handle === pending) pending = null;
        cleared += 1;
      },
    },
    pending: () => pending,
    clearCount: () => cleared,
  };
}

function hitFor(buttonText = 'Reject all'): ConsentHit {
  return {
    banner: document.createElement('div'),
    button: document.createElement('button'),
    kind: 'reject',
    buttonText,
    matchedPhrase: 'reject all',
    reason: 'reject-preferred',
  };
}

describe('cookie consent：幂等执行器', () => {
  it('默认常量：1.5s 首查、1s 节流、最多 5 次', () => {
    assert.equal(CONSENT_INITIAL_DELAY_MS, 1500);
    assert.equal(CONSENT_RETRY_THROTTLE_MS, 1000);
    assert.equal(CONSENT_MAX_ATTEMPTS, 5);
  });

  it('start 只排一次首查；stop 清掉定时器且 onFinish 只调一次', () => {
    const fake = fakeTimer();
    let finished = 0;
    const controller = createConsentController({
      isAllowed: async () => true,
      find: () => null,
      click: () => {},
      timer: fake.timer,
      onFinish: () => {
        finished += 1;
      },
    });

    controller.start();
    assert.equal(fake.pending()?.ms, CONSENT_INITIAL_DELAY_MS);
    const first = fake.pending();
    controller.start();
    assert.equal(fake.pending(), first, '重复 start 不应重排');

    controller.stop('manual');
    assert.equal(fake.pending(), null);
    assert.deepEqual(controller.stats(), {
      attempts: 0,
      handled: false,
      stopped: true,
      reason: 'manual',
    });
    controller.stop('again');
    assert.equal(finished, 1);
  });

  it('闸门拒绝时直接停止，不再扫描页面', async () => {
    let findCalls = 0;
    const controller = createConsentController({
      isAllowed: async () => false,
      find: () => {
        findCalls += 1;
        return hitFor();
      },
      click: () => {},
    });

    await controller.runAttempt();
    assert.equal(findCalls, 0);
    assert.deepEqual(controller.stats(), {
      attempts: 1,
      handled: false,
      stopped: true,
      reason: 'gate-blocked',
    });
  });

  it('闸门抛错按 fail closed 停止', async () => {
    const controller = createConsentController({
      isAllowed: async () => {
        throw new Error('worker asleep');
      },
      find: () => hitFor(),
      click: () => {},
    });
    await controller.runAttempt();
    assert.equal(controller.stats().reason, 'gate-error');
    assert.equal(controller.stats().stopped, true);
    assert.equal(controller.stats().handled, false);
  });

  it('找到横幅只点一次；后续 DOM 变动与手动重跑都不再点', async () => {
    let clicks = 0;
    const controller = createConsentController({
      isAllowed: async () => true,
      find: () => hitFor(),
      click: () => {
        clicks += 1;
      },
    });

    await controller.runAttempt();
    assert.equal(clicks, 1);
    assert.deepEqual(controller.stats(), {
      attempts: 1,
      handled: true,
      stopped: true,
      reason: 'handled',
    });

    controller.notifyMutation();
    await controller.runAttempt();
    assert.equal(clicks, 1);
    assert.equal(controller.stats().attempts, 1);
  });

  it('点击抛错也算处理过，不重试', async () => {
    let clicks = 0;
    const controller = createConsentController({
      isAllowed: async () => true,
      find: () => hitFor(),
      click: () => {
        clicks += 1;
        throw new Error('detached');
      },
    });

    await controller.runAttempt();
    assert.equal(clicks, 1);
    assert.equal(controller.stats().handled, true);
    assert.equal(controller.stats().stopped, true);

    await controller.runAttempt();
    assert.equal(clicks, 1);
  });

  it('没有横幅时消耗一次尝试，未到上限仍可等下一次变动', async () => {
    const fake = fakeTimer();
    const controller = createConsentController({
      isAllowed: async () => true,
      find: () => null,
      click: () => {},
      timer: fake.timer,
      maxAttempts: 2,
    });

    await controller.runAttempt();
    assert.deepEqual(controller.stats(), {
      attempts: 1,
      handled: false,
      stopped: false,
      reason: 'running',
    });

    controller.notifyMutation();
    assert.equal(fake.pending()?.ms, CONSENT_RETRY_THROTTLE_MS);
    const first = fake.pending();
    controller.notifyMutation();
    assert.equal(fake.pending(), first, '节流窗口内只排一次');
  });

  it('达到尝试次数上限后停止，并清掉待执行的重试', async () => {
    const fake = fakeTimer();
    const controller = createConsentController({
      isAllowed: async () => true,
      find: () => null,
      click: () => {},
      timer: fake.timer,
      maxAttempts: 2,
    });

    await controller.runAttempt();
    assert.equal(controller.stats().stopped, false);

    controller.notifyMutation();
    assert.ok(fake.pending());
    await controller.runAttempt();
    assert.deepEqual(controller.stats(), {
      attempts: 2,
      handled: false,
      stopped: true,
      reason: 'attempt-limit',
    });
    assert.equal(fake.pending(), null);

    await controller.runAttempt();
    assert.equal(controller.stats().attempts, 2);
  });

  it('扫描抛错不逃逸，按未找到横幅处理', async () => {
    const controller = createConsentController({
      isAllowed: async () => true,
      find: () => {
        throw new Error('hostile DOM');
      },
      click: () => {},
      maxAttempts: 1,
    });
    await controller.runAttempt();
    assert.equal(controller.stats().attempts, 1);
    assert.equal(controller.stats().stopped, true);
    assert.equal(controller.stats().reason, 'attempt-limit');
  });
});
