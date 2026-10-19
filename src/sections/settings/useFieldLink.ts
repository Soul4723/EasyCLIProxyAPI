import { useEffect } from 'react';
import { replaceRoute, useRoute } from '../../shell/router';
import { resolveSettingField, settingFieldRoute } from '../../services/settingsNavigation';

const HIGHLIGHT_MS = 2200;
const GIVE_UP_MS = 10000;
const FIELDS = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

let highlighted: { el: HTMLElement; timer: number } | null = null;

function highlight(el: HTMLElement) {
  if (highlighted) { window.clearTimeout(highlighted.timer); highlighted.el.removeAttribute('data-field-highlight'); }
  el.setAttribute('data-field-highlight', '');
  highlighted = { el, timer: window.setTimeout(() => { el.removeAttribute('data-field-highlight'); highlighted = null; }, HIGHLIGHT_MS) };
}

/**
 * The control to focus inside a field row: its first input (null while every input is still disabled, i.e. the config
 * has not loaded), else the checked radio of a segmented control, else any enabled button.
 */
function pickControl(el: HTMLElement) {
  if (el.querySelector('input, select, textarea')) return el.querySelector<HTMLElement>(FIELDS);
  return el.querySelector<HTMLElement>('[aria-checked="true"]:not([disabled])') ?? el.querySelector<HTMLElement>('button:not([disabled])');
}

/**
 * Deep link `#/settings/<tab>?field=<dotted.path>`: once the field's tab has rendered and its control is enabled
 * (template fields stay disabled until the config has loaded, so an unloaded skeleton is never highlighted),
 * scrolls the field into view, focuses its control and highlights it briefly. A link on the wrong tab is redirected
 * to the tab that renders the field; the param is dropped once handled, so the same link works again later.
 */
export function useSettingFieldLink(activeTab: string) {
  const route = useRoute();
  const field = route.page === 'settings' ? route.params.get('field') : null;
  useEffect(() => {
    if (!field) return undefined;
    const target = resolveSettingField(field);
    if (!target) { replaceRoute(`/settings/${activeTab}`); return undefined; }
    if (target.tab !== activeTab) { replaceRoute(settingFieldRoute(field)!); return undefined; }
    const done = () => { observer.disconnect(); window.clearTimeout(giveUp); };
    const attempt = () => {
      const el = document.querySelector<HTMLElement>(`#settings-panel [data-field-path="${CSS.escape(target.key)}"]`);
      const control = el && !el.closest('[hidden]') ? pickControl(el) : null;
      if (!el || !control) return;
      done();
      el.querySelectorAll('details').forEach((details) => { details.open = true; });
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      control.focus({ preventScroll: true });
      highlight(el);
      replaceRoute(`/settings/${target.tab}`);
    };
    const observer = new MutationObserver(attempt);
    const giveUp = window.setTimeout(() => { done(); replaceRoute(`/settings/${target.tab}`); }, GIVE_UP_MS);
    const panel = document.getElementById('settings-panel') ?? document.body;
    observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] });
    attempt();
    return done;
  }, [field, activeTab]);
}
