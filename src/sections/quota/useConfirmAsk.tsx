// Promise-based confirmation on top of the kit ConfirmDialog. Accepts the same options the quota services/hooks
// already use (title, message, details, warning), so useQuotaReset and friends work unchanged.
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../../ui';
import type { ConfirmationOptions } from '../../components/ConfirmationDialog';

export function useConfirmAsk() {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const ask = useCallback((next: ConfirmationOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOptions(next);
  }), []);

  const settle = useCallback((value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  }, []);

  const body: ReactNode = options ? (
    <div className="qt-confirm">
      <p>{options.message}</p>
      {options.details?.length ? (
        <dl className="qt-confirm__details">
          {options.details.map((detail) => (
            <div key={`${detail.label}:${detail.value}`}><dt>{detail.label}</dt><dd className="ec-mono">{detail.value}</dd></div>
          ))}
        </dl>
      ) : null}
      {options.warning ? <p className="qt-confirm__warn">{options.warning}</p> : null}
    </div>
  ) : null;

  const dialog = (
    <ConfirmDialog
      open={options !== null}
      title={options?.title ?? ''}
      message={body}
      confirmLabel={options?.confirmText}
      danger={options?.variant === 'danger'}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
  return { ask, dialog };
}
