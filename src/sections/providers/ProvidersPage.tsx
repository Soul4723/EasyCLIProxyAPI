import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FolderOpen, LogIn, RefreshCw } from 'lucide-react';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../shell/PageHeader';
import { RouteTabs } from '../../shell/RouteTabs';
import { routeHref } from '../../shell/router';
import type { SectionPageProps } from '../../shell/types';
import { Button, EmptyState, ErrorState, FilterChips, ProviderLogo, Skeleton } from '../../ui';
import { AddKeyButton, ApiKeyList, useApiProviders, type ApiProvidersController, type ProviderCategory } from './api';
import { AddMenu, KindMenu } from './AddMenu';
import {
  CredentialFilters, CredentialList, ModelExclusions, defaultCredentialFilter, useCredentials,
  type CredentialFilterValue, type CredentialsController,
} from './creds';
import { emptyStatusCounts } from './creds/model';
import { resolveBrands, type Brand } from './model';
import { ProviderCard, type BrandSummary } from './ProviderCard';
import { useOAuthSignIn, type OAuthSignInController } from './signin';
import { providersSubs } from './subs';

type Kind = 'all' | 'accounts' | 'keys';

function summaryOf(brand: Brand, creds: CredentialsController, api: ApiProvidersController): BrandSummary {
  const accounts = creds.summaryByBrand.get(brand.id);
  const keys = api.rows.filter((row) => row.brand === brand.id);
  return {
    accounts: accounts?.total ?? 0,
    accountStatus: accounts?.byStatus ?? emptyStatusCounts(),
    keys: keys.length,
    keysDisabled: keys.filter((row) => row.disabled).length,
  };
}

export function ProvidersPage({ sub, params }: SectionPageProps) {
  const { t } = useI18n();
  const signInRef = useRef<OAuthSignInController | null>(null);
  const creds = useCredentials({
    onReSignIn: (provider) => {
      const signIn = signInRef.current;
      const entry = signIn?.providers.find((p) => p.id === provider || p.brand === provider);
      if (signIn && entry) signIn.start(entry.id);
    },
  });
  const api = useApiProviders();
  const signIn = useOAuthSignIn({ onSuccess: () => { void creds.reload(); } });
  signInRef.current = signIn;
  const active = sub ?? providersSubs[0].id;
  const brandId = params.get('p');
  const credRef = params.get('cred');

  // Deep link from Overview / Quota: `#/providers?cred=<auth index or file name>` opens that credential.
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!credRef || creds.loading || openedRef.current === credRef) return;
    openedRef.current = credRef;
    creds.selectByRef(credRef);
  }, [credRef, creds]);

  const { subscriptions, apiOnly } = useMemo(
    () => resolveBrands(signIn.providers, creds.summaryByBrand.keys()),
    [signIn.providers, creds.summaryByBrand],
  );
  const allBrands = useMemo(() => [...subscriptions, ...apiOnly], [subscriptions, apiOnly]);
  const allKinds = useMemo(() => allBrands.flatMap((entry) => entry.kinds), [allBrands]);
  const brand = brandId ? allBrands.find((entry) => entry.id === brandId) : undefined;

  const [kindMenu, setKindMenu] = useState<{ brand: Brand; anchor: HTMLElement } | null>(null);
  const addKey = (target: Brand, anchor?: HTMLElement) => {
    if (target.kinds.length === 1) api.openCreate(target.kinds[0].id);
    else if (anchor) setKindMenu({ brand: target, anchor });
  };
  const signInDisabled = (target: Brand) => signIn.providers.find((p) => p.id === target.signInId)?.disabledReason;

  const loading = creds.loading || api.loading;
  const count = creds.rows.length + api.rows.length;
  const reloadAll = () => { void creds.reload(); void api.reload(); };

  const actions = (
    <>
      <AddMenu
        signIn={signIn.providers}
        kinds={allKinds}
        onSignIn={signIn.start}
        onAddKey={(kind: ProviderCategory) => api.openCreate(kind)}
        onImport={creds.openImport}
      />
      <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void creds.openFolder()} disabled={Boolean(creds.openFolderDisabledReason)} title={creds.openFolderDisabledReason}>
        {t('sec.providers.action.openFolder')}
      </Button>
      <Button size="sm" icon={<RefreshCw size={14} className={loading ? 'spin' : undefined} />} onClick={reloadAll} disabled={loading}>
        {t('sec.providers.action.refresh')}
      </Button>
    </>
  );

  let body;
  if (active === 'exclusions') {
    body = <ModelExclusions controller={creds} />;
  } else if (active === 'all') {
    body = <AllCredentials creds={creds} api={api} />;
  } else if (brandId) {
    body = brand
      ? <ProviderDetail brand={brand} creds={creds} api={api} signIn={signIn} onAddKey={addKey} signInDisabledReason={signInDisabled(brand)} />
      : <EmptyState title={t('sec.providers.detail.unknown')} action={<a className="pv-back" href={routeHref('providers')}><ArrowLeft size={14} />{t('sec.providers.detail.back')}</a>} />;
  } else if (creds.error && api.error) {
    body = <ErrorState title={t('sec.providers.error')} message={creds.error} onRetry={reloadAll} />;
  } else {
    body = (
      <>
        <BrandGroup title={t('sec.providers.group.subscriptions')} brands={subscriptions} loading={loading} creds={creds} api={api} signIn={signIn} onAddKey={addKey} signInDisabled={signInDisabled} />
        <BrandGroup title={t('sec.providers.group.apiOnly')} brands={apiOnly} loading={loading} creds={creds} api={api} signIn={signIn} onAddKey={addKey} signInDisabled={signInDisabled} />
      </>
    );
  }

  return (
    <div className="ec-sec-providers">
      <PageHeader
        title={t('sec.providers.title')}
        count={loading ? undefined : count}
        actions={actions}
        tabs={<RouteTabs page="providers" subs={providersSubs} active={active} ariaLabel={t('sec.providers.title')} />}
      />
      <div className="ec-page-body">{body}</div>
      {creds.dialogs}
      {api.dialogs}
      {signIn.dialogs}
      {kindMenu ? (
        <KindMenu open anchorEl={kindMenu.anchor} kinds={kindMenu.brand.kinds} onClose={() => setKindMenu(null)} onPick={(kind) => api.openCreate(kind)} />
      ) : null}
    </div>
  );
}

function BrandGroup({ title, brands, loading, creds, api, signIn, onAddKey, signInDisabled }: {
  title: string;
  brands: readonly Brand[];
  loading: boolean;
  creds: CredentialsController;
  api: ApiProvidersController;
  signIn: OAuthSignInController;
  onAddKey: (brand: Brand, anchor?: HTMLElement) => void;
  signInDisabled: (brand: Brand) => string | undefined;
}) {
  return (
    <section className="pv-group" aria-label={title}>
      <h2 className="pv-group__title">{title}</h2>
      <div className="pv-grid">
        {brands.map((brand) => loading ? (
          <Skeleton key={brand.id} height={132} />
        ) : (
          <ProviderCard
            key={brand.id}
            brand={brand}
            summary={summaryOf(brand, creds, api)}
            onSignIn={brand.signInId ? () => signIn.start(brand.signInId!) : undefined}
            signInDisabledReason={signInDisabled(brand)}
            onAddKey={brand.kinds.length ? (anchor) => onAddKey(brand, anchor) : undefined}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderDetail({ brand, creds, api, signIn, onAddKey, signInDisabledReason }: {
  brand: Brand;
  creds: CredentialsController;
  api: ApiProvidersController;
  signIn: OAuthSignInController;
  onAddKey: (brand: Brand, anchor?: HTMLElement) => void;
  signInDisabledReason?: string;
}) {
  const { t } = useI18n();
  const summary = summaryOf(brand, creds, api);
  const [filter, setFilter] = useState<CredentialFilterValue>({ ...defaultCredentialFilter, provider: brand.id });
  const showAccounts = Boolean(brand.signInId) || summary.accounts > 0;
  return (
    <>
      <a className="pv-back" href={routeHref('providers')}><ArrowLeft size={14} aria-hidden="true" />{t('sec.providers.detail.back')}</a>
      <div className="pv-detail-head">
        <ProviderLogo provider={brand.id} size={40} />
        <h2>{brand.name}</h2>
        <div className="pv-detail-actions">
          {brand.signInId ? (
            <Button variant="primary" size="sm" icon={<LogIn size={14} />} onClick={() => signIn.start(brand.signInId!)} disabled={Boolean(signInDisabledReason)} title={signInDisabledReason}>
              {t('sec.providers.card.signIn')}
            </Button>
          ) : null}
          {brand.kinds.length === 1 ? <AddKeyButton controller={api} brand={brand.id} variant={brand.signInId ? 'secondary' : 'primary'} /> : null}
          {brand.kinds.length > 1 ? (
            <Button size="sm" variant="primary" onClick={(event) => onAddKey(brand, event.currentTarget)}>{t('sec.providers.card.addKey')}</Button>
          ) : null}
        </div>
      </div>
      {showAccounts ? (
        <section className="pv-section" aria-label={t('sec.providers.detail.accounts')}>
          <h3 className="pv-group__title">{t('sec.providers.detail.accounts')}</h3>
          {summary.accounts > 0 ? <CredentialFilters controller={creds} value={filter} onChange={setFilter} hideProvider /> : null}
          {summary.accounts > 0 ? (
            <CredentialList controller={creds} provider={brand.id} query={filter.query} status={filter.status} showProvider={false} />
          ) : <EmptyState title={t('sec.providers.detail.emptyAccounts')} />}
        </section>
      ) : null}
      {brand.kinds.length ? (
        <section className="pv-section" aria-label={t('sec.providers.detail.keys')}>
          <h3 className="pv-group__title">{t('sec.providers.detail.keys')}</h3>
          <ApiKeyList controller={api} brand={brand.id} />
        </section>
      ) : null}
    </>
  );
}

function AllCredentials({ creds, api }: { creds: CredentialsController; api: ApiProvidersController }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<CredentialFilterValue>(defaultCredentialFilter);
  const [kind, setKind] = useState<Kind>('all');
  const brand = filter.provider === 'all' ? undefined : filter.provider;
  if (!creds.loading && !api.loading && creds.rows.length + api.rows.length === 0) {
    return <EmptyState title={t('sec.providers.all.empty')} />;
  }
  return (
    <>
      <div className="pv-toolbar">
        <FilterChips<Kind>
          ariaLabel={t('sec.providers.all.kind')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: t('sec.providers.all.kindAll'), count: creds.rows.length + api.rows.length },
            { value: 'accounts', label: t('sec.providers.all.kindAccounts'), count: creds.rows.length },
            { value: 'keys', label: t('sec.providers.all.kindKeys'), count: api.rows.length },
          ]}
        />
      </div>
      <CredentialFilters controller={creds} value={filter} onChange={setFilter} />
      {kind !== 'keys' ? (
        <section className="pv-section" aria-label={t('sec.providers.detail.accounts')}>
          <h3 className="pv-group__title">{t('sec.providers.detail.accounts')}</h3>
          <CredentialList controller={creds} provider={brand} query={filter.query} status={filter.status} />
        </section>
      ) : null}
      {kind !== 'accounts' ? (
        <section className="pv-section" aria-label={t('sec.providers.detail.keys')}>
          <h3 className="pv-group__title">{t('sec.providers.detail.keys')}</h3>
          <ApiKeyList controller={api} brand={brand} query={filter.query} />
        </section>
      ) : null}
    </>
  );
}
