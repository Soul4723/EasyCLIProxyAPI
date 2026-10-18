import { useEffect, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button } from '../../ui';

/** Width below which mapping rows stack. A class flag rather than a container query: containment would break the picker's fixed dropdown. */
const NARROW_PX = 560;

/** Returns [ref, narrow]; attach the ref to the panel root. */
export function useNarrowPanel<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setNarrow(el.clientWidth < NARROW_PX));
    observer.observe(el);
    setNarrow(el.clientWidth < NARROW_PX);
    return () => observer.disconnect();
  }, []);
  return [ref, narrow] as const;
}

/** Model-list load failure line with a refresh action (shown above the mapping rows). */
export function ClaudeModelError({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  const { t } = useI18n();
  return (
    <div className="ag-claude-error" role="status" title={t('agents.claudeCodeRuntime.connectionHint')}>
      <CircleAlert size={14} aria-hidden />
      <span className="ag-claude-error-text">{t('agents.model.loadFailed')}</span>
      <Button size="xs" variant="outline" onClick={onRefresh} loading={loading}>{t('agents.model.refresh')}</Button>
    </div>
  );
}
