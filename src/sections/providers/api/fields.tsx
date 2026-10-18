// Form controls for the API-key forms. The kit has buttons/toggles/search but no text fields yet, so these live with
// the api package (class prefix `ec-api-`, token styled in api.css; dialogs are portaled, so no ancestor scoping).
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronRight, CircleAlert, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import { cx, IconButton } from '../../../ui';

export function Field({ label, hint, wide, children }: { label: ReactNode; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <label className={cx('ec-api-field', wide && 'ec-api-field--wide')}>
      <span className="ec-api-field__label">{label}</span>
      {children}
      {hint ? <small className="ec-api-field__hint">{hint}</small> : null}
    </label>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx('ec-api-input', className)} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx('ec-api-input ec-api-input--area', className)} {...rest} />;
});

export const SelectInput = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function SelectInput(
  { className, ...rest },
  ref,
) {
  return <select ref={ref} className={cx('ec-api-input ec-api-input--select', className)} {...rest} />;
});

/** Checkbox with a text label (form fields that are saved with the form, unlike the immediate Toggle). */
export function CheckField({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="ec-api-check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Collapsible group (native details) used for Advanced settings and per-item options. */
export function Disclosure({ title, meta, defaultOpen, nested, children }: {
  title: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  nested?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={cx('ec-api-disclosure', nested && 'ec-api-disclosure--nested')} open={defaultOpen}>
      <summary>
        <ChevronRight className="ec-api-disclosure__chev" size={14} aria-hidden="true" />
        <span>{title}</span>
        {meta ? <span className="ec-api-disclosure__meta">{meta}</span> : null}
      </summary>
      <div className="ec-api-disclosure__body">{children}</div>
    </details>
  );
}

export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="ec-api-grid">{children}</div>;
}

export function FormSection({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="ec-api-section">
      <header className="ec-api-section__head">
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

/** One clear error line (role=alert); the text goes through the privacy mask because errors often echo hosts and keys. */
export function ErrorLine({ message, title, onDismiss }: { message: string; title?: string; onDismiss?: () => void }) {
  const mask = usePrivacyMask();
  const { t } = useI18n();
  return (
    <p className="ec-api-error" role="alert">
      <CircleAlert size={14} aria-hidden="true" />
      <span>{title ? <strong>{title}: </strong> : null}{mask.text(message)}</span>
      {onDismiss ? <IconButton size="xs" label={t('common.close')} icon={<X size={12} />} onClick={onDismiss} /> : null}
    </p>
  );
}
