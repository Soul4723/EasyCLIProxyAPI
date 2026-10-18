// Dev-only harness (#/providers?preview=api). Removed when the Providers page is assembled.
import { useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { PageHeader } from '../../../shell/PageHeader';
import { Button, FilterChips, ProviderLogo, SearchInput, SegmentedControl, providerInfo } from '../../../ui';
import { AddKeyButton, API_KINDS, ApiKeyList, useApiProviders } from './index';

const L = {
  title: 'API keys harness',
  all: 'All',
  scope: 'Brand',
  compact: 'Compact rows',
  on: 'On',
  off: 'Off',
  search: 'Search keys',
  checkAll: 'Check all',
  reload: 'Reload',
  list: 'List',
  rows: 'Rows',
};

const BRANDS = ['all', ...Array.from(new Set(API_KINDS.map((kind) => kind.brand)))];

export default function ApiPreview() {
  const controller = useApiProviders();
  const [brand, setBrand] = useState('all');
  const [query, setQuery] = useState('');
  const [compact, setCompact] = useState(false);
  const scope = brand === 'all' ? undefined : brand;
  return (
    <>
      <PageHeader
        title={L.title}
        count={controller.rows.length}
        actions={(
          <>
            <AddKeyButton controller={controller} brand={scope} />
            <Button size="sm" icon={<Activity size={14} />} onClick={() => controller.checkAllHealth(scope)} disabled={controller.loading || controller.busy}>{L.checkAll}</Button>
            <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void controller.reload()} disabled={controller.loading || controller.busy}>{L.reload}</Button>
          </>
        )}
      />
      <div className="ec-page-body">
        <FilterChips
          ariaLabel={L.scope}
          value={brand}
          onChange={setBrand}
          options={BRANDS.map((id) => ({
            value: id,
            label: id === 'all' ? L.all : providerInfo(id).name,
            count: id === 'all' ? controller.rows.length : controller.countByBrand[id] ?? 0,
            icon: id === 'all' ? undefined : <ProviderLogo provider={id} size={14} />,
          }))}
        />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ flex: 1 }}><SearchInput value={query} onChange={setQuery} placeholder={L.search} /></div>
          <SegmentedControl
            ariaLabel={L.rows}
            value={compact ? 'compact' : 'normal'}
            onChange={(value) => setCompact(value === 'compact')}
            options={[{ value: 'normal', label: L.list }, { value: 'compact', label: L.compact }]}
          />
        </div>
        <ApiKeyList controller={controller} brand={scope} query={query} compact={compact} />
        {controller.dialogs}
      </div>
    </>
  );
}
