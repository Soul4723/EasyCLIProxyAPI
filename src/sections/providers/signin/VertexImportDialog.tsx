/**
 * VertexImportDialog: imports a Google service account JSON as a Vertex AI credential (import_vertex_credential via
 * services/vertexImport). The JSON comes from a file or is pasted; the core validates it and saves
 * auth-dir/vertex-<project>.json.
 *
 * Props: open, onClose, onImported(result) (called once the core accepted the credential).
 */
import { useId, useRef, useState } from 'react';
import { CircleCheck, Upload } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import { routeHref } from '../../../shell/router';
import { Button, Dialog, Masked, ProviderLogo, SegmentedControl } from '../../../ui';
import { importVertexCredential, type VertexImportResult } from '../../../services/vertexImport';
import { VERTEX_PROVIDER_ID } from './logic';
import './signin.css';

export type VertexImportDialogProps = {
  open: boolean;
  onClose: () => void;
  onImported?: (result: VertexImportResult) => void;
};

export function VertexImportDialog({ open, onClose, onImported }: VertexImportDialogProps) {
  return open ? <VertexImportForm onClose={onClose} onImported={onImported} /> : null;
}

function VertexImportForm({ onClose, onImported }: Omit<VertexImportDialogProps, 'open'>) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const formId = useId();
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [json, setJson] = useState('');
  const [location, setLocation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<VertexImportResult | null>(null);
  const busy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const clearOutcome = () => {
    setError('');
    setResult(null);
  };

  const importCredential = async () => {
    if (busy.current) return;
    clearOutcome();
    let source = file;
    if (mode === 'paste') {
      if (!json.trim()) { setError(t('sec.providers.signin.vertex.jsonRequired')); return; }
      source = new File([json], 'service-account.json', { type: 'application/json' });
    } else if (!source) {
      setError(t('sec.providers.signin.vertex.fileRequired'));
      return;
    }
    busy.current = true;
    setLoading(true);
    try {
      const imported = await importVertexCredential(source!, location);
      setResult(imported);
      setJson('');
      onImported?.(imported);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!loading}
      size="md"
      title={(
        <span className="ec-signin-title">
          <ProviderLogo provider="vertex" size={24} />
          <span>{t('sec.providers.signin.vertex.title')}</span>
        </span>
      )}
      footer={result ? (
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <a
            className="ec-btn ec-btn--primary ec-btn--md"
            href={routeHref('providers', null, { p: VERTEX_PROVIDER_ID })}
            onClick={onClose}
          >
            {t('sec.providers.signin.success.view')}
          </a>
        </>
      ) : (
        <>
          <Button disabled={loading} onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form={formId} variant="primary" icon={<Upload />} loading={loading}>
            {t(loading ? 'sec.providers.signin.vertex.importing' : 'sec.providers.signin.vertex.import')}
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        className="ec-signin-body"
        onSubmit={(event) => { event.preventDefault(); void importCredential(); }}
      >
        <p className="ec-signin-step__hint">{t('sec.providers.signin.vertex.description')}</p>
        <div className="ec-signin-mode">
          <SegmentedControl
            value={mode}
            onChange={(next) => { setMode(next); clearOutcome(); }}
            ariaLabel={t('sec.providers.signin.vertex.title')}
            size="sm"
            options={[
              { value: 'file', label: t('sec.providers.signin.vertex.modeFile') },
              { value: 'paste', label: t('sec.providers.signin.vertex.modePaste') },
            ]}
          />
        </div>
        {mode === 'file' ? (
          <div className="ec-signin-field">
            <span className="ec-signin-field__label">{t('sec.providers.signin.vertex.file')}</span>
            <div className="ec-signin-file">
              <Button size="sm" icon={<Upload />} disabled={loading} onClick={() => fileInput.current?.click()}>
                {t('sec.providers.signin.vertex.chooseFile')}
              </Button>
              <span className="ec-signin-file__name">
                {file ? <Masked value={file.name} mono /> : t('sec.providers.signin.vertex.noFile')}
              </span>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              disabled={loading}
              aria-label={t('sec.providers.signin.vertex.file')}
              onChange={(event) => { setFile(event.currentTarget.files?.[0] ?? null); clearOutcome(); }}
            />
          </div>
        ) : (
          <label className="ec-signin-field">
            <span className="ec-signin-field__label">{t('sec.providers.signin.vertex.json')}</span>
            <textarea
              className="ec-signin-textarea"
              value={json}
              disabled={loading}
              placeholder={t('sec.providers.signin.vertex.jsonPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => { setJson(event.currentTarget.value); clearOutcome(); }}
            />
          </label>
        )}
        <label className="ec-signin-field">
          <span className="ec-signin-field__label">{t('sec.providers.signin.vertex.location')}</span>
          <input
            className="ec-signin-input"
            value={location}
            disabled={loading}
            placeholder={t('sec.providers.signin.vertex.locationPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => { setLocation(event.currentTarget.value); clearOutcome(); }}
          />
          <span className="ec-signin-field__hint">{t('sec.providers.signin.vertex.locationHint')}</span>
        </label>
        {error ? (
          <p className="ec-signin-feedback ec-signin-feedback--error" role="alert">{privacy.text(error)}</p>
        ) : null}
        {result ? (
          <div role="status" className="ec-signin-outcome">
            <p className="ec-signin-feedback ec-signin-feedback--ok">
              <CircleCheck size={14} aria-hidden="true" /> {t('sec.providers.signin.vertex.success')}
            </p>
            <dl className="ec-signin-summary">
              <dt>{t('sec.providers.signin.vertex.project')}</dt>
              <dd><Masked value={result.projectId} kind="identifier" mono /></dd>
              <dt>{t('sec.providers.signin.vertex.email')}</dt>
              <dd><Masked value={result.email} kind="identifier" /></dd>
              <dt>{t('sec.providers.signin.vertex.location')}</dt>
              <dd>{result.location}</dd>
              <dt>{t('sec.providers.signin.vertex.authFile')}</dt>
              <dd><Masked value={result.authFile} identities={[result.projectId, result.email]} mono /></dd>
            </dl>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
