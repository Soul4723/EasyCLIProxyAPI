/** Small presentational pieces shared by the credential list and the credential panel. */
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import { Chip, Countdown, Masked, ProviderLogo, ProviderName, StatusPill, providerInfo } from '../../../ui';
import { authFileRequestStats } from '../../../services/authFileRequests';
import { requestShare, type CredentialRow } from './model';

/** Logo + identity + file name. `showProvider` adds the brand name under the logo tile's row when the list is mixed. */
export function CredentialIdentity({ row, showProvider = true }: { row: CredentialRow; showProvider?: boolean }) {
  const { t } = useI18n();
  const primary = row.identity || row.name;
  return (
    <div className="ec-cred-identity">
      {showProvider ? <ProviderLogo provider={row.provider} size={28} title={providerInfo(row.provider).name} /> : null}
      <div className="ec-cred-identity__text">
        <span className="ec-cred-identity__primary">
          <Masked value={primary} identities={row.identities} />
          {row.runtimeOnly ? <Chip size="sm" tone="outline">{t('authFiles.runtime')}</Chip> : null}
        </span>
        <span className="ec-cred-identity__secondary">
          {showProvider && !row.identity ? <ProviderName provider={row.provider} /> : null}
          {row.identity ? <Masked value={row.name} identities={row.identities} mono /> : null}
        </span>
      </div>
    </div>
  );
}

/** Status pill; cooldown adds a live countdown, error/expired the core's message on hover. */
export function CredentialStatusCell({ row }: { row: CredentialRow }) {
  const mask = usePrivacyMask();
  const detail = row.statusDetail ? mask.text(row.statusDetail, row.identities) : undefined;
  return (
    <div className="ec-cred-status" title={detail}>
      <StatusPill status={row.status} size="sm" />
      {row.status === 'cooldown' && row.cooldownUntilMs ? (
        <span className="ec-cred-status__time"><Countdown to={row.cooldownUntilMs} compact /></span>
      ) : null}
      {(row.status === 'error' || row.status === 'expired') && detail ? (
        <span className="ec-cred-status__detail">{detail}</span>
      ) : null}
    </div>
  );
}

/** Request mini bar: ok/failed counts plus a two-part proportion bar (core totals since start). */
export function RequestBar({ row }: { row: CredentialRow }) {
  const { t, formatNumber } = useI18n();
  const share = requestShare(row.requests);
  if (!row.requests || !share) {
    return <span className="ec-cred-req ec-cred-req--none" title={t('authFiles.requests.unavailable')}>—</span>;
  }
  const recent = authFileRequestStats(row.file);
  const rate = recent.recentRate === null ? '' : ` · ${t('authFiles.requests.rate', { rate: `${Math.round(recent.recentRate * 100)}%` })}`;
  const label = `${t('authFiles.requests.success', { count: formatNumber(row.requests.ok) })} · ${t('authFiles.requests.failure', { count: formatNumber(row.requests.fail) })}${rate}`;
  return (
    <div className="ec-cred-req" title={label} aria-label={label}>
      <div className="ec-cred-req__nums">
        <span className="ec-cred-req__ok">{formatNumber(row.requests.ok)}</span>
        <span className={row.requests.fail > 0 ? 'ec-cred-req__fail' : 'ec-cred-req__zero'}>{formatNumber(row.requests.fail)}</span>
      </div>
      <div className="ec-cred-req__bar" aria-hidden="true">
        <span className="ec-cred-req__bar-ok" style={{ width: `${share.okPct}%` }} />
        <span className="ec-cred-req__bar-fail" style={{ width: `${share.failPct}%` }} />
      </div>
    </div>
  );
}
