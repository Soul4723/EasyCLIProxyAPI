import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import type { ClientApiProfile } from '../../services/clientAccess';
import { Card, CardHeader, Chip, CopyButton, ProviderLogo, SegmentedControl } from '../../ui';
import { routeHref } from '../../shell/router';

export type ConnectCardProps = {
  profiles: ClientApiProfile[];
  /** undefined = loading, null = none configured. Raw value: only ever shortened/masked for display. */
  clientKey: string | null | undefined;
  keyError: boolean;
  /** The core accepts client requests. */
  connectable: boolean;
};

/** Environment-variable snippet per client profile. */
export function connectSnippet(profile: ClientApiProfile, key: string): string {
  switch (profile.id) {
    case 'claude':
      return `export ANTHROPIC_BASE_URL="${profile.baseUrl}"\nexport ANTHROPIC_AUTH_TOKEN="${key}"`;
    case 'gemini':
      return `export GOOGLE_GEMINI_BASE_URL="${profile.baseUrl}"\nexport GEMINI_API_KEY="${key}"`;
    default:
      return `export OPENAI_BASE_URL="${profile.baseUrl}"\nexport OPENAI_API_KEY="${key}"`;
  }
}

/** `sk-…9c1e` style short form; the raw key never reaches the DOM. */
export function shortKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length);
  const prefix = key.startsWith('sk-') ? 'sk-' : key.slice(0, 2);
  return `${prefix}…${key.slice(-4)}`;
}

const LOGO = { openai: 'openai', claude: 'claude', gemini: 'gemini' } as const;

/** Home of the client connect profile: base URL, masked access key, snippet. Key management lives in Settings → Access keys. */
export function ConnectCard({ profiles, clientKey, keyError, connectable }: ConnectCardProps) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const [active, setActive] = useState<ClientApiProfile['id']>('openai');
  const profile = profiles.find((item) => item.id === active) ?? profiles[0];
  const hasKey = typeof clientKey === 'string' && clientKey.length > 0;
  return (
    <Card as="section" className="ov-connect" aria-labelledby="ov-connect-title">
      <CardHeader
        title={<span id="ov-connect-title">{t('sec.overview.connect')}</span>}
        actions={<Chip tone={connectable ? 'ok' : 'neutral'} icon={<span className={`ov-dot ov-dot--${connectable ? 'ok' : 'neutral'}`} />}>{t(connectable ? 'sec.overview.connectable' : 'sec.overview.waiting')}</Chip>}
      />
      {!profile ? (
        <p className="ov-muted">{t('sec.overview.noEndpoint')}</p>
      ) : (
        <>
          <SegmentedControl
            ariaLabel={t('sec.overview.protocol')} size="sm" value={active} onChange={setActive}
            options={profiles.map((item) => ({ value: item.id, label: <span className="ov-seg"><ProviderLogo provider={LOGO[item.id]} size={14} />{item.name}</span> }))}
          />
          <div className="ov-field">
            <span className="ov-field__label">{t('sec.overview.baseUrl')}</span>
            <span className="ov-field__row">
              <code className="ov-field__value ec-trunc" title={profile.baseUrl}>{profile.baseUrl}</code>
              <CopyButton size="sm" value={profile.baseUrl} />
            </span>
          </div>
          <div className="ov-field">
            <span className="ov-field__label">
              {t('sec.overview.accessKey')}
              <a className="ov-link" href={routeHref('settings', 'access')}>{t('sec.overview.manage')}<ArrowUpRight size={12} aria-hidden="true" /></a>
            </span>
            <span className="ov-field__row">
              {hasKey ? (
                <>
                  <code className="ov-field__value ec-trunc" data-testid="ov-key">{mask.enabled ? mask.identifier(clientKey) : shortKey(clientKey)}</code>
                  <CopyButton size="sm" value={clientKey} />
                  <CopyButton size="sm" value={connectSnippet(profile, clientKey)} label={t('sec.overview.snippet')} />
                </>
              ) : (
                <span className={keyError ? 'ov-field__value ov-field__value--error' : 'ov-field__value ov-muted'}>
                  {keyError ? t('sec.overview.keyError') : clientKey === undefined ? t('sec.overview.loading') : t('sec.overview.noKey')}
                </span>
              )}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}
