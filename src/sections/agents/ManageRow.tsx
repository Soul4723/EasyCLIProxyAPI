import type { ReactNode } from 'react';

/** One management row: label (+ one-line hint) · current value · actions. */
export function ManageRow({ label, hint, value, actions, ...rest }: { label: string; hint?: string; value?: ReactNode; actions?: ReactNode; 'data-row'?: string }) {
  return (
    <div className="ag-mg-row" {...rest}>
      <div className="ag-mg-label">
        <strong>{label}</strong>
        {hint ? <span className="ec-muted">{hint}</span> : null}
      </div>
      <div className="ag-mg-value">{value}</div>
      <div className="ag-mg-actions">{actions}</div>
    </div>
  );
}
