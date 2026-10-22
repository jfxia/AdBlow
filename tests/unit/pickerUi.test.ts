/**
 * 页面内拾取器（shadow root UI + 交互 + 保存）。
 *
 * 用 jsdom 覆盖：shadow root 隔离、宿主不被自身判定/隐藏、点击被拦截、面板生成可编辑
 * 选择器、保存写入 picked 规则并立即隐藏、Esc 取消、非法选择器不落库。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PICKER_UI_ATTR,
  hideElement,
  judgeElement,
  type JudgeOptions,
} from '../../src/content/engine.ts';
import { createPicker, type PickerController, type PickerStrings } from '../../src/content/picker.ts';
import { learnedKey } from '../../src/content/learn.ts';
import { memoryStore, type KvStore } from '../../src/content/storage.ts';

const STRINGS: PickerStrings = {
  title: 'pick-title',
  hint: 'pick-hint',
  selectorLabel: 'selector-label',
  save: 'save',
  cancel: 'cancel',
  invalid: 'invalid',
};

type Mounted = {
  wrap: HTMLElement;
  picker: PickerController;
  store: KvStore;
  saved: Promise<string>;
};

function mount(html: string): Mounted {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap);

  const store = memoryStore();
  let resolveSaved: (selector: string) => void = () => {};
  const saved = new Promise<string>((resolve) => {
    resolveSaved = resolve;
  });

  const picker = createPicker({
    doc: document,
    host: 'a.cc',
    store,
    strings: () => STRINGS,
    onSaved: (selector) => resolveSaved(selector),
  });
  picker.attach();
  return { wrap, picker, store, saved };
}

function cleanup(mounted: Mounted): void {
  mounted.picker.detach();
  mounted.wrap.remove();
}

function click(el: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
  el.dispatchEvent(event);
  return event;
}

function pressEscape(): void {
  const Keyboard = (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  document.body.dispatchEvent(
    new Keyboard('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
}

const inputOf = (picker: PickerController): HTMLInputElement =>
  picker.shadow!.querySelector('input.selector') as HTMLInputElement;
const panelOf = (picker: PickerController): HTMLElement =>
  picker.shadow!.querySelector('.panel') as HTMLElement;
const errorOf = (picker: PickerController): HTMLElement =>
  picker.shadow!.querySelector('.error') as HTMLElement;
const saveOf = (picker: PickerController): HTMLButtonElement =>
  picker.shadow!.querySelector('button.save') as HTMLButtonElement;

describe('拾取器 UI：shadow root 隔离', () => {
  it('UI 全部在 shadow root 内，宿主带标记且不拦截页面点击', () => {
    const mounted = mount('<div class="ad-slot"></div>');
    try {
      mounted.picker.start();
      const host = document.querySelector<HTMLElement>(`[${PICKER_UI_ATTR}]`);
      assert.ok(host);
      assert.equal(host!.shadowRoot, null, 'closed shadow root 不应暴露给页面');
      assert.ok(mounted.picker.shadow);
      assert.ok(mounted.picker.shadow!.querySelector('.panel'));
      assert.ok(mounted.picker.shadow!.querySelector('input.selector'));
      assert.ok(mounted.picker.shadow!.querySelector('.highlight'));
      assert.equal(host!.style.pointerEvents, 'none', '宿主必须让点击穿透');
      // The light DOM carries no picker text, so page styles/text queries cannot see it.
      assert.equal(host!.textContent, '');
    } finally {
      mounted.picker.stop();
      cleanup(mounted);
    }
  });

  it('❗拾取器自己不会被 AdBlow 判定或隐藏', () => {
    const mounted = mount('<div class="ad-slot"></div>');
    try {
      mounted.picker.start();
      const host = document.querySelector<HTMLElement>(`[${PICKER_UI_ATTR}]`)!;
      const options: JudgeOptions = {
        injected: () => false,
        host: 'a.cc',
        viewportArea: 1920 * 1080,
        selectors: { curated: [], learned: [], picked: [] },
      };
      assert.equal(judgeElement(host, options), null);
      hideElement(host, 'test');
      assert.equal(host.hasAttribute('data-adblow-hidden'), false);
    } finally {
      mounted.picker.stop();
      cleanup(mounted);
    }
  });
});

describe('拾取器交互：高亮、拦截点击、生成可编辑选择器', () => {
  it('鼠标移动高亮当前元素', () => {
    const mounted = mount('<div class="ad-slot"></div>');
    try {
      mounted.picker.start();
      const target = mounted.wrap.firstElementChild!;
      target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, composed: true }));
      const highlight = mounted.picker.shadow!.querySelector('.highlight') as HTMLElement;
      assert.equal(highlight.hidden, false);
    } finally {
      mounted.picker.stop();
      cleanup(mounted);
    }
  });

  it('❗点击选中时阻止默认行为与传播，页面处理器一次都不触发', () => {
    const mounted = mount('<div class="ad-slot" id="target">ad</div>');
    const target = mounted.wrap.firstElementChild!;
    let pageClicks = 0;
    const pageHandler = (): void => {
      pageClicks += 1;
    };
    document.addEventListener('click', pageHandler);
    document.addEventListener('mousedown', pageHandler);
    try {
      mounted.picker.start();
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
      target.dispatchEvent(event);

      assert.equal(event.defaultPrevented, true, '必须阻止这次点击的默认行为');
      assert.equal(pageClicks, 0, '点击不能传到页面');
      assert.equal(panelOf(mounted.picker).hidden, false, '选中后应显示面板');
      assert.equal(inputOf(mounted.picker).value, '.ad-slot');
    } finally {
      document.removeEventListener('click', pageHandler);
      document.removeEventListener('mousedown', pageHandler);
      mounted.picker.stop();
      cleanup(mounted);
    }
  });

  it('Esc 退出拾取模式并移除 UI', () => {
    const mounted = mount('<div class="ad-slot"></div>');
    try {
      mounted.picker.start();
      assert.equal(mounted.picker.active, true);
      pressEscape();
      assert.equal(mounted.picker.active, false);
      assert.equal(document.querySelector(`[${PICKER_UI_ATTR}]`), null);
    } finally {
      cleanup(mounted);
    }
  });
});

describe('拾取器保存：写入 picked 规则并立即隐藏', () => {
  it('❗保存后写入 learned:<host>，元素立即隐藏，拾取模式退出', async () => {
    const mounted = mount('<div class="ad-slot" id="target">ad</div>');
    const target = mounted.wrap.firstElementChild!;
    try {
      mounted.picker.start();
      click(target);
      inputOf(mounted.picker).value = '#target';
      click(saveOf(mounted.picker));

      const selector = await Promise.race([
        mounted.saved,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('保存未在 2 秒内完成')), 2000),
        ),
      ]);
      assert.equal(selector, '#target');

      const stored = (await mounted.store.get<Record<string, { picked?: boolean; promoted?: boolean }>>(
        learnedKey('a.cc'),
      ))!;
      assert.equal(stored['#target']!.picked, true);
      assert.equal(stored['#target']!.promoted, true);
      assert.equal(target.getAttribute('data-adblow-hidden'), '1', '元素必须立即隐藏');
      assert.equal(mounted.picker.active, false);
      assert.equal(document.querySelector(`[${PICKER_UI_ATTR}]`), null);
    } finally {
      mounted.picker.stop();
      cleanup(mounted);
    }
  });

  it('❗非法选择器不保存、不隐藏、不退出', async () => {
    const mounted = mount('<div class="ad-slot" id="target">ad</div>');
    const target = mounted.wrap.firstElementChild!;
    try {
      mounted.picker.start();
      click(target);
      inputOf(mounted.picker).value = 'div';
      click(saveOf(mounted.picker));
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(errorOf(mounted.picker).hidden, false);
      assert.equal(await mounted.store.get(learnedKey('a.cc')), undefined);
      assert.equal(target.hasAttribute('data-adblow-hidden'), false);
      assert.equal(mounted.picker.active, true);
    } finally {
      mounted.picker.stop();
      cleanup(mounted);
    }
  });

  it('禁用选择器（.post-card）不写坏数据', async () => {
    const mounted = mount('<div class="ad-slot post-card" id="target">ad</div>');
    try {
      mounted.picker.start();
      click(mounted.wrap.firstElementChild!);
      inputOf(mounted.picker).value = '.post-card';
      click(saveOf(mounted.picker));
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(errorOf(mounted.picker).hidden, false);
      assert.equal(await mounted.store.get(learnedKey('a.cc')), undefined);
    } finally {
      mounted.picker.stop();
      cleanup(mounted);
    }
  });
});

describe('右键预选：直接打开已填好的面板', () => {
  it('❗start(目标) 跳过悬停与点击，面板、高亮和选择器一次就位', () => {
    const mounted = mount('<div class="ad-slot" id="target">ad</div>');
    const target = mounted.wrap.firstElementChild!;
    try {
      mounted.picker.start(target);

      assert.equal(mounted.picker.active, true);
      assert.equal(panelOf(mounted.picker).hidden, false, '面板应立即显示');
      assert.equal(inputOf(mounted.picker).value, '.ad-slot', '选择器应已生成并填入');
      const highlight = mounted.picker.shadow!.querySelector('.highlight') as HTMLElement;
      assert.equal(highlight.hidden, false, '目标元素应已高亮');
    } finally {
      mounted.picker.stop();
      cleanup(mounted);
    }
  });

  it('❗预选后用户仍可修改选择器并保存', async () => {
    const mounted = mount('<div class="ad-slot" id="target">ad</div>');
    const target = mounted.wrap.firstElementChild!;
    try {
      mounted.picker.start(target);
      inputOf(mounted.picker).value = '#target';
      click(saveOf(mounted.picker));

      const selector = await Promise.race([
        mounted.saved,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('保存未在 2 秒内完成')), 2000),
        ),
      ]);
      assert.equal(selector, '#target');
      assert.equal(target.getAttribute('data-adblow-hidden'), '1');
      assert.equal(mounted.picker.active, false);
    } finally {
      mounted.picker.stop();
      cleanup(mounted);
    }
  });
});

describe('手动规则在判定层：命中即隐藏（用户显式选择优先）', () => {
  const options = (picked: string[]): JudgeOptions => ({
    injected: () => false,
    host: 'a.cc',
    viewportArea: 1920 * 1080,
    selectors: { curated: [], learned: [], picked },
  });

  it('picked 选择器命中即隐藏（无需命名或行为证据）', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="manual-ad"></div>';
    const el = wrap.firstElementChild!;
    assert.equal(judgeElement(el, options(['.manual-ad']))?.kind, 'picked');
  });

  it('手动规则优先于正文守卫：用户显式拾取的节点在后续访问中仍会隐藏', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="manual-ad"><article itemtype="http://schema.org/BlogPosting"></article></div>';
    assert.equal(judgeElement(wrap.firstElementChild!, options(['.manual-ad']))?.kind, 'picked');
  });
});
