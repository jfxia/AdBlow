import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNavigationSource, looksLikeNavigationHijack } from '../../src/inject/clickGuard.ts';

/**
 * 行内属性（`<body onclick="location.href='…'">`）到达我们手里是**源码字符串**而不是函数，
 * 原来的 `looksLikeNavigationHijack` 只看函数，于是这类处理器一个都没被识别出来。
 */
describe('isNavigationSource：按源码文本判断跳转形状', () => {
  it('识别常见的跳转写法', () => {
    assert.equal(isNavigationSource("location.href='https://ads.example.com/x'"), true);
    assert.equal(isNavigationSource("window.location = '/next'"), true);
    assert.equal(isNavigationSource("location.assign('https://x.example')"), true);
    assert.equal(isNavigationSource("document.location.replace('https://x.example')"), true);
    assert.equal(isNavigationSource("window.open('https://x.example')"), true);
  });

  it('不误判普通代码', () => {
    assert.equal(isNavigationSource("console.log(location.pathname)"), false);
    assert.equal(isNavigationSource("history.pushState({}, '', '/next')"), false);
    assert.equal(isNavigationSource("document.querySelector('.a').classList.add('x')"), false);
    assert.equal(isNavigationSource(''), false);
  });

  it('函数版本与文本版本一致', () => {
    const hijack = (): void => {
      location.href = 'https://ads.example.com/x';
    };
    const readOnly = (): string => location.pathname;
    assert.equal(looksLikeNavigationHijack(hijack), true);
    assert.equal(looksLikeNavigationHijack(readOnly), false);
  });
});
