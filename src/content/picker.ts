/**
 * On-page element picker (content script side).
 *
 * Interaction: highlight the hovered element with an outline, intercept the click that
 * selects it, then show a small panel where the generated CSS selector can be edited before
 * saving. The context-menu entry point skips the first two steps: the caller passes the
 * element that was right-clicked and the panel opens already filled in. Saving hides the
 * element through the existing `hideElement` path and writes a `picked` entry into
 * `learned:<host>` (site-scoped by the storage key).
 *
 * Two structural decisions:
 *   - the whole UI lives in a **closed shadow root**, so page CSS cannot restyle it and
 *     AdBlow's own `document.querySelectorAll` passes cannot reach it; the host element is
 *     tagged with PICKER_UI_ATTR so the engine's judge/hide paths skip it explicitly;
 *   - blocking listeners are installed on `window` in the capture phase at content-script
 *     start (`attach()`), i.e. before page scripts register theirs, so
 *     `stopImmediatePropagation` really keeps the click from reaching the page.
 */
import { PICKER_MAX_MATCHES, pickerSelector, pickerSelectorProblem } from '../engine/picker.ts';
import { PICKER_UI_ATTR, hideElement, isPickerUi } from './engine.ts';
import { addPickedSelector } from './learn.ts';
import type { KvStore } from './storage.ts';

export type PickerStrings = {
  title: string;
  hint: string;
  selectorLabel: string;
  save: string;
  cancel: string;
  invalid: string;
};

export type PickerOptions = {
  doc: Document;
  /** Page hostname, used as the suffix of the site-scoped `learned:<host>` key. */
  host: string;
  store: KvStore;
  /** Resolved lazily so the content script can boot without touching chrome.i18n. */
  strings: () => PickerStrings;
  /** Notified after a rule was written and the element hidden (used for tests/logging). */
  onSaved?: (selector: string) => void;
};

export type PickerController = {
  /** Install the capture-phase blockers; call once, early (document_start). */
  attach(): void;
  detach(): void;
  /**
   * Mount the picker. With `preselected` the panel opens at once, already filled with that
   * element's selector — the context-menu path has no second hover/click to wait for.
   */
  start(preselected?: Element): void;
  stop(): void;
  readonly active: boolean;
  /** Shadow root of the mounted UI, or null when inactive (exposed for tests). */
  readonly shadow: ShadowRoot | null;
};

const PICKER_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  .highlight {
    position: fixed;
    z-index: 2147483647;
    margin: 0;
    padding: 0;
    border: 2px solid #7c5cff;
    background: rgba(124, 92, 255, 0.12);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9) inset;
    pointer-events: none;
  }
  .panel {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483647;
    width: 320px;
    max-width: calc(100vw - 32px);
    padding: 14px;
    border: 1px solid #e6e8ef;
    border-radius: 12px;
    background: #ffffff;
    color: #16181d;
    box-shadow: 0 1px 2px rgba(16, 18, 25, 0.08), 0 12px 32px rgba(16, 18, 25, 0.18);
    font: 13px/1.55 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
    pointer-events: auto;
  }
  .panel strong { display: block; font-size: 14px; margin-bottom: 4px; }
  .hint { margin: 0 0 10px; color: #5f6672; font-size: 11.5px; line-height: 1.5; }
  .field { display: block; margin-bottom: 8px; }
  .field span { display: block; color: #5f6672; font-size: 11.5px; margin-bottom: 4px; }
  .selector {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid #e6e8ef;
    border-radius: 8px;
    background: #f6f7fb;
    color: inherit;
    font: 12.5px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  .selector:focus { outline: 2px solid #7c5cff; outline-offset: 1px; }
  .error { margin: 0 0 8px; color: #c0392b; font-size: 11.5px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .actions button {
    font: inherit;
    padding: 6px 12px;
    border: 1px solid #e6e8ef;
    border-radius: 8px;
    background: #ffffff;
    color: inherit;
    cursor: pointer;
  }
  .actions button.save {
    border-color: transparent;
    background: linear-gradient(135deg, #7c5cff, #3b2fd1);
    color: #ffffff;
  }
  .actions button:disabled { opacity: 0.55; cursor: default; }
  @media (prefers-color-scheme: dark) {
    .panel { background: #1b1d23; color: #eceef3; border-color: #2a2d36; }
    .hint, .field span { color: #9aa1ad; }
    .selector { background: #15161a; border-color: #2a2d36; }
    .error { color: #ff8a80; }
    .actions button { background: #1b1d23; color: #eceef3; border-color: #2a2d36; }
  }
`;

const UNPICKABLE_TAGS = new Set(['HTML', 'BODY', 'HEAD']);

/** Why a right-clicked element could not be preselected. */
export type PreselectFallback = 'none' | 'detached' | 'picker-ui' | 'unpickable';

export type PreselectDecision = {
  /** The element to open the panel on, or null when the caller must fall back. */
  target: Element | null;
  /** Null when `target` exists; otherwise the reason the recorded element was unusable. */
  fallback: PreselectFallback | null;
};

/**
 * Can the element recorded at `contextmenu` time still be preselected?
 *
 * This runs when the native menu click arrives, an arbitrary time after the right-click:
 * dynamic ads re-render, sites swap nodes on mousedown, and the user may right-click the
 * picker's own panel while it is open. Any stale or self-referential target must degrade
 * to ordinary picking rather than open the panel on a detached node (whose generated
 * selector would be meaningless).
 *
 * Pure by design: no chrome.*, no timers, only the DOM passed in — unit-testable.
 */
export function resolvePreselect(
  recorded: Element | null,
  doc: Document,
): PreselectDecision {
  if (!recorded) return { target: null, fallback: 'none' };
  if (isPickerUi(recorded)) return { target: null, fallback: 'picker-ui' };
  // The picker itself refuses html/body/head (hiding them empties the page), so preselecting
  // them would only show an error panel. Normal picking mode is the useful fallback.
  if (UNPICKABLE_TAGS.has(recorded.tagName)) return { target: null, fallback: 'unpickable' };
  if (!doc.documentElement?.contains(recorded)) return { target: null, fallback: 'detached' };
  return { target: recorded, fallback: null };
}

export function createPicker(options: PickerOptions): PickerController {
  const { doc, host, store } = options;

  let active = false;
  let attached = false;
  let hostEl: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let highlight: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let errorEl: HTMLElement | null = null;
  let saveButton: HTMLButtonElement | null = null;
  let hovered: Element | null = null;
  let selected: Element | null = null;
  let saving = false;

  const strings = (): PickerStrings => options.strings();

  const eventPath = (event: Event): EventTarget[] => {
    try {
      return typeof event.composedPath === 'function' ? event.composedPath() : [];
    } catch {
      return [];
    }
  };

  const isPickerEvent = (event: Event): boolean => {
    if (!hostEl) return false;
    return eventPath(event).some((node) => node === hostEl);
  };

  const elementFrom = (event: Event): Element | null => {
    const first = eventPath(event)[0];
    if (first && (first as Node).nodeType === 1) return first as Element;
    const target = event.target;
    if (target && (target as Node).nodeType === 1) return target as Element;
    return null;
  };

  const isUnpickable = (el: Element): boolean => {
    if (UNPICKABLE_TAGS.has(el.tagName)) return true;
    return !doc.documentElement.contains(el);
  };

  const drawHighlight = (el: Element): void => {
    if (!highlight) return;
    const rect = el.getBoundingClientRect();
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
    highlight.hidden = false;
  };

  const clearError = (): void => {
    if (!errorEl) return;
    errorEl.hidden = true;
    errorEl.textContent = '';
    input?.removeAttribute('aria-invalid');
  };

  const showError = (): void => {
    if (!errorEl) return;
    errorEl.textContent = strings().invalid;
    errorEl.hidden = false;
    input?.setAttribute('aria-invalid', 'true');
  };

  const onMove = (event: Event): void => {
    if (!active || selected !== null) return;
    if (isPickerEvent(event)) return;
    const target = elementFrom(event);
    if (!target || isUnpickable(target)) {
      hovered = null;
      if (highlight) highlight.hidden = true;
      return;
    }
    hovered = target;
    drawHighlight(target);
  };

  const select = (target: Element): void => {
    selected = target;
    drawHighlight(target);
    if (!input || !panel) return;
    const generated = pickerSelector(target, doc, PICKER_MAX_MATCHES);
    input.value = generated ?? '';
    if (generated) clearError();
    else showError();
    panel.hidden = false;
    input.focus();
    input.select?.();
  };

  const onPointer = (event: Event): void => {
    if (!active) return;
    // Events from the panel belong to it: they are not page clicks and must not be blocked.
    if (isPickerEvent(event)) return;

    // Stop the press/click from reaching page handlers. Only the *click-like* events get
    // preventDefault: canceling pointerdown/mousedown is allowed to suppress the
    // compatibility click in some engines, which would break selection entirely. The
    // default action that must not happen (navigation, middle-click open, context menu) is
    // carried by click/auxclick/contextmenu, so canceling those is sufficient.
    if (event.type === 'click' || event.type === 'auxclick' || event.type === 'contextmenu') {
      event.preventDefault();
    }
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (event.type !== 'click' || selected !== null) return;
    const target = elementFrom(event);
    if (!target || isUnpickable(target)) return;
    select(target);
  };

  const onKey = (event: Event): void => {
    if (!active) return;
    const key = (event as KeyboardEvent).key;
    if (key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    stop();
  };

  const onViewportChange = (): void => {
    if (!active) return;
    const target = selected ?? hovered;
    if (target && doc.documentElement.contains(target)) drawHighlight(target);
  };

  const save = async (): Promise<void> => {
    if (!input || saving || !active) return;
    const selector = input.value.trim();
    if (pickerSelectorProblem(selector, doc, PICKER_MAX_MATCHES) !== null) {
      showError();
      return;
    }

    const targets = Array.from(doc.querySelectorAll(selector)).filter(
      (el) => !el.closest(`[${PICKER_UI_ATTR}]`),
    );
    if (targets.length === 0) {
      showError();
      return;
    }

    saving = true;
    if (saveButton) saveButton.disabled = true;
    try {
      // Storage first: if the write fails, the page must not be left in a state the rule
      // manager cannot explain (hidden element, no rule).
      await addPickedSelector(store, host, selector);
    } catch {
      saving = false;
      if (saveButton) saveButton.disabled = false;
      showError();
      return;
    }

    for (const el of targets) hideElement(el, 'picked');
    saving = false;
    options.onSaved?.(selector);
    stop();
  };

  const buildUi = (): void => {
    hostEl = doc.createElement('div');
    hostEl.setAttribute(PICKER_UI_ATTR, '');
    // Inline !important, because page rules like `html > div { display:none }` would
    // otherwise be able to remove the picker's host.
    hostEl.style.setProperty('position', 'fixed', 'important');
    hostEl.style.setProperty('left', '0', 'important');
    hostEl.style.setProperty('top', '0', 'important');
    hostEl.style.setProperty('width', '0', 'important');
    hostEl.style.setProperty('height', '0', 'important');
    hostEl.style.setProperty('z-index', '2147483647', 'important');
    hostEl.style.setProperty('display', 'block', 'important');
    hostEl.style.setProperty('visibility', 'visible', 'important');
    hostEl.style.setProperty('opacity', '1', 'important');
    // Only the panel is interactive; the invisible host must not swallow page clicks.
    hostEl.style.setProperty('pointer-events', 'none', 'important');

    shadow = hostEl.attachShadow({ mode: 'closed' });

    const style = doc.createElement('style');
    style.textContent = PICKER_CSS;
    shadow.appendChild(style);

    highlight = doc.createElement('div');
    highlight.className = 'highlight';
    highlight.hidden = true;
    shadow.appendChild(highlight);

    panel = doc.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');

    const title = doc.createElement('strong');
    title.className = 'title';
    title.textContent = strings().title;
    panel.appendChild(title);

    const hint = doc.createElement('p');
    hint.className = 'hint';
    hint.textContent = strings().hint;
    panel.appendChild(hint);

    const field = doc.createElement('label');
    field.className = 'field';
    const label = doc.createElement('span');
    label.textContent = strings().selectorLabel;
    field.appendChild(label);
    input = doc.createElement('input');
    input.className = 'selector';
    input.type = 'text';
    input.spellcheck = false;
    input.setAttribute('autocomplete', 'off');
    field.appendChild(input);
    panel.appendChild(field);

    errorEl = doc.createElement('p');
    errorEl.className = 'error';
    errorEl.hidden = true;
    panel.appendChild(errorEl);

    const actions = doc.createElement('div');
    actions.className = 'actions';

    const cancelButton = doc.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'cancel';
    cancelButton.textContent = strings().cancel;
    cancelButton.addEventListener('click', () => stop());
    actions.appendChild(cancelButton);

    saveButton = doc.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'save';
    saveButton.textContent = strings().save;
    saveButton.addEventListener('click', () => void save());
    actions.appendChild(saveButton);

    panel.appendChild(actions);
    shadow.appendChild(panel);

    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key !== 'Enter') return;
      event.preventDefault();
      void save();
    });

    const root = doc.documentElement ?? doc.body;
    root.appendChild(hostEl);
  };

  const teardownUi = (): void => {
    hostEl?.remove();
    hostEl = null;
    shadow = null;
    highlight = null;
    panel = null;
    input = null;
    errorEl = null;
    saveButton = null;
    hovered = null;
    selected = null;
    saving = false;
  };

  function stop(): void {
    if (!active && !hostEl) return;
    active = false;
    teardownUi();
  }

  return {
    attach(): void {
      if (attached) return;
      const win = doc.defaultView;
      if (!win) return;
      // Capture phase on `window`: registered at document_start, so these run before any
      // handler the page installs later on window/document/element during the same phase.
      win.addEventListener('mousemove', onMove, true);
      win.addEventListener('pointermove', onMove, true);
      for (const type of [
        'pointerdown',
        'pointerup',
        'mousedown',
        'mouseup',
        'click',
        'auxclick',
        'contextmenu',
      ]) {
        win.addEventListener(type, onPointer, true);
      }
      win.addEventListener('keydown', onKey, true);
      doc.addEventListener('scroll', onViewportChange, true);
      win.addEventListener('resize', onViewportChange, true);
      attached = true;
    },

    detach(): void {
      if (!attached) return;
      const win = doc.defaultView;
      if (win) {
        win.removeEventListener('mousemove', onMove, true);
        win.removeEventListener('pointermove', onMove, true);
        for (const type of [
          'pointerdown',
          'pointerup',
          'mousedown',
          'mouseup',
          'click',
          'auxclick',
          'contextmenu',
        ]) {
          win.removeEventListener(type, onPointer, true);
        }
        win.removeEventListener('keydown', onKey, true);
        win.removeEventListener('resize', onViewportChange, true);
      }
      doc.removeEventListener('scroll', onViewportChange, true);
      attached = false;
      stop();
    },

    start(preselected?: Element): void {
      if (active) return;
      buildUi();
      active = true;
      // Context-menu path: the target is already known, so hover and the selecting click are
      // skipped entirely. `select` shows the panel even when no selector can be generated
      // (empty field + error), which is still better than silently doing nothing.
      if (preselected) select(preselected);
    },

    stop,

    get active(): boolean {
      return active;
    },

    get shadow(): ShadowRoot | null {
      return shadow;
    },
  };
}
