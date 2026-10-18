import { KeyRound, LogIn, Plus } from 'lucide-react';
import { useI18n } from '../../i18n';
import { routeHref } from '../../shell/router';
import { Button, Card, ProviderLogo, statusColor } from '../../ui';
import { CREDENTIAL_STATUS_ORDER, type Brand, type StatusCounts } from './model';

export type BrandSummary = {
  accounts: number;
  accountStatus: StatusCounts;
  keys: number;
  keysDisabled: number;
};

/** Segmented bar: one segment per credential/key, coloured by the status vocabulary. */
export function StatusBar({ counts, keys, keysDisabled }: { counts: StatusCounts; keys: number; keysDisabled: number }) {
  const { t } = useI18n();
  const segments = [
    ...CREDENTIAL_STATUS_ORDER.map((status) => ({ status, n: counts[status] + (status === 'available' ? keys - keysDisabled : 0) })),
    { status: 'disabled' as const, n: 0 },
  ];
  segments[CREDENTIAL_STATUS_ORDER.indexOf('disabled')].n += keysDisabled;
  const total = segments.reduce((sum, segment) => sum + segment.n, 0);
  return (
    <div className="pv-bar" role="img" aria-label={segments.filter((s) => s.n).map((s) => `${s.n} ${t(`ui.status.${s.status}`)}`).join(' · ') || t('sec.providers.card.none')}>
      {total === 0 ? <span className="pv-bar__seg pv-bar__seg--empty" style={{ flex: 1 }} /> : segments.filter((s) => s.n > 0).map((s) => (
        <span key={s.status} className="pv-bar__seg" style={{ flex: s.n, background: statusColor(s.status) }} title={`${s.n} ${t(`ui.status.${s.status}`)}`} />
      ))}
    </div>
  );
}

/** Provider-first card (C1/C5 language + 9Router tile): logo, counts, status bar, primary actions. */
export function ProviderCard({ brand, summary, onSignIn, onAddKey, signInDisabledReason }: {
  brand: Brand;
  summary: BrandSummary;
  onSignIn?: () => void;
  onAddKey?: (anchor: HTMLElement) => void;
  signInDisabledReason?: string;
}) {
  const { t } = useI18n();
  const problems = summary.accountStatus.error + summary.accountStatus.expired + summary.accountStatus.cooldown;
  return (
    <Card as="article" className="pv-card" data-brand={brand.id}>
      <a className="pv-card__link" href={routeHref('providers', null, { p: brand.id })} aria-label={brand.name}>
        <div className="pv-card__head">
          <ProviderLogo provider={brand.id} size={32} />
          <strong className="pv-card__name">{brand.name}</strong>
          {problems > 0 ? <span className="pv-card__flag" title={t('sec.providers.card.attention', { count: problems })}>{problems}</span> : null}
        </div>
        <div className="pv-card__counts">
          {brand.signInId ? (
            <span className="pv-count"><LogIn size={13} aria-hidden="true" /><b className="ec-num">{summary.accounts}</b> {t(summary.accounts === 1 ? 'sec.providers.card.account' : 'sec.providers.card.accounts')}</span>
          ) : null}
          {brand.apiKinds.length ? (
            <span className="pv-count"><KeyRound size={13} aria-hidden="true" /><b className="ec-num">{summary.keys}</b> {t(summary.keys === 1 ? 'sec.providers.card.key' : 'sec.providers.card.keys')}</span>
          ) : null}
        </div>
        <StatusBar counts={summary.accountStatus} keys={summary.keys} keysDisabled={summary.keysDisabled} />
      </a>
      <div className="pv-card__actions">
        {onSignIn ? (
          <Button size="sm" variant="secondary" icon={<LogIn size={14} />} onClick={onSignIn} disabled={Boolean(signInDisabledReason)} title={signInDisabledReason}>
            {t('sec.providers.card.signIn')}
          </Button>
        ) : null}
        {onAddKey ? (
          <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={(event) => onAddKey(event.currentTarget)}>
            {t('sec.providers.card.addKey')}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
