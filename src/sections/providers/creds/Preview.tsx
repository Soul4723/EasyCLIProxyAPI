/**
 * Self-contained harness for the creds package: `#/providers?preview=creds` (+ `&creds=one|states|forty` for the mock data,
 * `&only=<brand>` for a single-provider list). The lead composes the real page from the same exports; remove with the hook.
 */
import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, Import } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { PageHeader } from '../../../shell/PageHeader';
import { useRoute } from '../../../shell/router';
import { Button, SegmentedControl } from '../../../ui';
import { CredentialFilters } from './CredentialFilters';
import { CredentialList } from './CredentialList';
import { ModelExclusions } from './ModelExclusions';
import { defaultCredentialFilter } from './model';
import { useCredentials } from './useCredentials';

export default function CredentialsPreview() {
  const { t } = useI18n();
  const { params } = useRoute();
  const only = params.get('only') ?? undefined;
  const ref = params.get('cred');
  const [signedIn, setSignedIn] = useState('');
  const controller = useCredentials({ onReSignIn: setSignedIn });
  // Deep link: `&cred=<file name or auth index>` opens that credential once the list has loaded.
  useEffect(() => {
    if (ref) controller.selectByRef(ref);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, controller.rows.length]);
  const [tab, setTab] = useState<'list' | 'exclusions'>('list');
  const [filter, setFilter] = useState(defaultCredentialFilter);
  return (
    <>
      <PageHeader
        title={t('sec.providers.title')}
        count={controller.rows.length}
        actions={(
          <>
            <Button size="sm" icon={<Import size={14} />} disabled={controller.busy} onClick={controller.openImport}>{t('authFiles.import')}</Button>
            <span title={controller.openFolderDisabledReason}>
              <Button size="sm" icon={<FolderOpen size={14} />} disabled={controller.busy || Boolean(controller.openFolderDisabledReason)}
                onClick={() => void controller.openFolder()}>{t('authFiles.openDirectory')}</Button>
            </span>
            <Button size="sm" icon={<RefreshCw size={14} />} loading={controller.loading} onClick={() => void controller.reload()}>{t('common.refresh')}</Button>
          </>
        )}
      />
      <div className="ec-page-body">
        <SegmentedControl<'list' | 'exclusions'> ariaLabel={t('authFiles.title')} value={tab} onChange={setTab}
          options={[
            { value: 'list', label: t('authFiles.title'), count: controller.rows.length },
            { value: 'exclusions', label: t('authFiles.models.toolbarButton') },
          ]} />
        {tab === 'list' ? (
          <>
            <CredentialFilters controller={controller} value={only ? { ...filter, provider: only } : filter}
              hideProvider={Boolean(only)} onChange={setFilter} />
            <CredentialList controller={controller} provider={only ?? (filter.provider === 'all' ? undefined : filter.provider)}
              query={filter.query} status={filter.status} showProvider={!only} />
          </>
        ) : <ModelExclusions controller={controller} />}
      </div>
      <output data-testid="resignin" hidden>{signedIn}</output>
      {controller.dialogs}
    </>
  );
}
