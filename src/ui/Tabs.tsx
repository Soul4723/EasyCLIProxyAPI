/**
 * Tabs: pill tab row for switching between panels in one view. Also exports tabPanelProps.
 *
 * Props:
 * - tabs: { id: string; label: ReactNode; count?: number; disabled?: boolean }[]
 * - active (required): id of the selected tab
 * - onChange(id): called on click and on arrow/Home/End navigation (automatic activation)
 * - idBase: prefix for DOM ids; defaults to a generated id
 * - ariaLabel (required): accessible name of the tablist
 *
 * Ids: tab = `${idBase}-tab-${id}`, panel = `${idBase}-panel`.
 * Wire the panel with tabPanelProps(idBase, active). Hash sync is the shell's job, not this component's.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import './Tabs.css';

export interface TabItem {
  id: string;
  label: ReactNode;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  idBase?: string;
  ariaLabel: string;
}

/** Attributes for the tabpanel element that belongs to the active tab. */
export function tabPanelProps(idBase: string, activeId: string) {
  return {
    role: 'tabpanel' as const,
    id: `${idBase}-panel`,
    'aria-labelledby': `${idBase}-tab-${activeId}`,
  };
}

export function Tabs({ tabs, active, onChange, idBase, ariaLabel }: TabsProps) {
  const { formatNumber } = useI18n();
  const generatedId = useId();
  const base = idBase ?? generatedId;
  const listRef = useRef<HTMLDivElement>(null);
  const activeIndex = tabs.findIndex((tab) => tab.id === active);
  const firstEnabled = tabs.findIndex((tab) => !tab.disabled);
  const tabStop = activeIndex >= 0 && !tabs[activeIndex].disabled ? activeIndex : firstEnabled;

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const enabled = tabs.map((tab, i) => (tab.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const position = enabled.indexOf(index);
    let nextIndex: number;
    switch (e.key) {
      case 'ArrowRight':
        nextIndex = enabled[(position + 1) % enabled.length];
        break;
      case 'ArrowLeft':
        nextIndex = enabled[(position - 1 + enabled.length) % enabled.length];
        break;
      case 'Home':
        nextIndex = enabled[0];
        break;
      case 'End':
        nextIndex = enabled[enabled.length - 1];
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = tabs[nextIndex];
    onChange(next.id);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  }

  return (
    <div ref={listRef} role="tablist" aria-label={ariaLabel} className="ec-tabs">
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            id={`${base}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${base}-panel`}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={tab.disabled}
            className={cx('ec-tabs__tab', selected && 'ec-tabs__tab--on')}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            <span className="ec-tabs__label">{tab.label}</span>
            {tab.count != null && <em className="ec-tabs__count">{formatNumber(tab.count)}</em>}
          </button>
        );
      })}
    </div>
  );
}
