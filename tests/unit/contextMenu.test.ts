/**
 * 右键菜单：标题兜底、manifest 权限、五份语言包的一致性。
 *
 * 菜单标题是唯一一处“运行时取不到就算”的文案：chrome.i18n 对未知 key 返回空串，
 * 空标题会让菜单项变成空白，所以兜底必须是可用的英文文案。权限则用一条断言盯住
 * ——contextMenus 被误删时，菜单会静默消失，没有别的测试会发现。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  CONTEXT_MENU_PICK_FALLBACK,
  contextMenuPickTitle,
} from '../../src/engine/contextMenu.ts';

const publicUrl = new URL('../../public/', import.meta.url);
const LOCALES = ['zh_CN', 'en', 'es', 'fr', 'ja'] as const;

type CatalogEntry = { message: string; description?: string };
type Catalog = Record<string, CatalogEntry>;

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(new URL(rel, publicUrl), 'utf8')) as T;
}

const manifest = readJson<{ permissions?: string[]; host_permissions?: string[] }>('manifest.json');
const catalogs = new Map(
  LOCALES.map((loc) => [loc, readJson<Catalog>(`_locales/${loc}/messages.json`)] as const),
);

describe('右键菜单：标题解析', () => {
  it('有译文时直接使用 chrome.i18n 的文案', () => {
    const title = contextMenuPickTitle((key) => (key === 'contextMenuPick' ? '拦截该元素' : ''));
    assert.equal(title, '拦截该元素');
  });

  it('❗取不到译文时用兜底文案（空串 / undefined / 抛异常）', () => {
    assert.equal(contextMenuPickTitle(() => ''), CONTEXT_MENU_PICK_FALLBACK);
    assert.equal(contextMenuPickTitle(() => undefined), CONTEXT_MENU_PICK_FALLBACK);
    assert.equal(contextMenuPickTitle(() => null), CONTEXT_MENU_PICK_FALLBACK);
    assert.equal(
      contextMenuPickTitle(() => {
        throw new Error('i18n unavailable');
      }),
      CONTEXT_MENU_PICK_FALLBACK,
    );
    assert.ok(CONTEXT_MENU_PICK_FALLBACK.trim().length > 0, '兜底文案不能为空');
  });

  it('纯空白译文也视为取不到', () => {
    assert.equal(contextMenuPickTitle(() => '   '), CONTEXT_MENU_PICK_FALLBACK);
  });
});

describe('右键菜单：manifest 与语言包', () => {
  it('❗manifest.json 声明 contextMenus 权限（被误删则菜单静默消失）', () => {
    assert.ok(Array.isArray(manifest.permissions), 'manifest.permissions 必须是数组');
    assert.ok(
      manifest.permissions!.includes('contextMenus'),
      `permissions 缺少 contextMenus：${manifest.permissions!.join(', ')}`,
    );
    // The feature must not widen page access: content scripts still run on <all_urls>.
    assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  });

  it('❗五种语言键集完全一致，且都含 contextMenuPick', () => {
    const dirs = readdirSync(new URL('_locales/', publicUrl)).sort();
    assert.deepEqual(dirs, [...LOCALES].sort(), '语言包目录必须是这五种');

    const base = catalogs.get('zh_CN')!;
    const baseKeys = Object.keys(base).sort();
    for (const loc of LOCALES) {
      const catalog = catalogs.get(loc)!;
      assert.deepEqual(
        Object.keys(catalog).sort(),
        baseKeys,
        `${loc}/messages.json 的键集与 zh_CN 不一致`,
      );
      assert.ok(
        catalog.contextMenuPick?.message.trim(),
        `${loc}/messages.json 缺少可用的 contextMenuPick`,
      );
    }
  });

  it('contextMenuPick 的译者注释是同一句英文', () => {
    const base = catalogs.get('zh_CN')!.contextMenuPick!;
    assert.equal(typeof base.description, 'string');
    assert.ok(base.description!.trim().length > 0);
    assert.ok(
      !/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(base.description!),
      'description 必须用英文',
    );
    for (const loc of LOCALES) {
      assert.equal(
        catalogs.get(loc)!.contextMenuPick!.description,
        base.description,
        `${loc} 的 description 与其他语言不一致`,
      );
    }
  });

  it('中英文案符合“拦截右键元素”的语义', () => {
    assert.equal(catalogs.get('zh_CN')!.contextMenuPick!.message, '使用 AdBlow 拦截该元素');
    assert.equal(
      catalogs.get('en')!.contextMenuPick!.message,
      'Block this element with AdBlow',
    );
  });
});
