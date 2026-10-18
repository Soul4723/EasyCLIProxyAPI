import { useRef, useState, type ReactNode } from 'react';
import { Copy, Download, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { AppearanceControls } from '../shell/AppMenu';
import { PageHeader } from '../shell/PageHeader';
import {
  AreaChart, Badge, Button, Card, CardHeader, ChartLegend, Chip, ConfirmDialog, CopyButton, Countdown, DataTable, Dialog,
  EmptyState, ErrorState, FilterChips, HBar, IconButton, Masked, Pagination, Popover, PopoverHeading, PopoverItem, PopoverSeparator,
  ProgressBar, ProviderLogo, ProviderName, QuotaBar, RelativeTime, SearchInput, SegmentedControl, SidePanel, Skeleton, Sparkline,
  StatTile, StatusPill, STATUS_ORDER, Tabs, Toggle, tabPanelProps, providerInfo, type SortState,
} from './index';
import './KitGallery.css';

// Dev-only reference page (hidden route #/kit). Sample content is data, not UI copy.
const SAMPLE = {
  title: 'UI kit', buttons: 'Buttons', status: 'Status vocabulary', providers: 'Provider logos', controls: 'Controls',
  data: 'Data', charts: 'Charts', overlays: 'Overlays', states: 'States', tokens: 'Tokens',
  words: ['Primary', 'Secondary', 'Ghost', 'Danger', 'Outline'],
  rows: [
    { id: 'a', name: 'maya.ortiz@example.dev', provider: 'claude', left: 62, resets: 6_480_000 },
    { id: 'b', name: 'dev.amara@example.org', provider: 'codex', left: 18, resets: 14_700_000 },
    { id: 'c', name: 'noor.haddad@example.com', provider: 'antigravity', left: 0, resets: 1_320_000 },
    { id: 'd', name: 'r.okafor@example.net', provider: 'xai', left: null, resets: 0 },
  ],
  vendors: ['claude', 'codex', 'antigravity', 'xai', 'kimi', 'devin', 'gemini', 'vertex', 'openai', 'deepseek', 'openrouter', 'copilot', 'unknown-vendor'],
} as const;

const SWATCHES = ['bg', 'surface', 'raised', 'popover', 'hover', 'sidebar', 'border', 'fg', 'fg-muted', 'accent', 's1', 's2', 's3', 's4', 's5', 's6'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="ec-kit-section">
      <CardHeader title={title} />
      {children}
    </Card>
  );
}

/** Reference gallery of every kit component (dev only: `#/kit`). Use the controls at the top to flip theme/density. */
export default function KitGallery() {
  const [seg, setSeg] = useState('grid');
  const [tab, setTab] = useState('one');
  const [chip, setChip] = useState('all');
  const [on, setOn] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [popover, setPopover] = useState(false);
  const [panel, setPanel] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const anchor = useRef<HTMLButtonElement>(null);
  const series = [
    { id: 'in', label: 'Input', color: 'var(--ec-s1)', values: [3, 5, 4, 8, 12, 9, 14, 10, 7, 11, 6, 4] },
    { id: 'out', label: 'Output', color: 'var(--ec-s4)', values: [1, 2, 2, 3, 5, 4, 6, 4, 3, 5, 2, 2] },
  ];
  return (
    <>
      <PageHeader title={SAMPLE.title} />
      <div className="ec-page-body ec-kit">
        <Section title={SAMPLE.tokens}>
          <div className="ec-kit-row"><AppearanceControls /></div>
          <div className="ec-kit-swatches">
            {SWATCHES.map((name) => (
              <span key={name} className="ec-kit-swatch"><i style={{ background: `var(--ec-${name})` }} />{name}</span>
            ))}
          </div>
        </Section>

        <Section title={SAMPLE.buttons}>
          <div className="ec-kit-row">
            {(['primary', 'secondary', 'ghost', 'danger', 'outline'] as const).map((variant, index) => (
              <Button key={variant} variant={variant} icon={<Plus size={14} />}>{SAMPLE.words[index]}</Button>
            ))}
            <Button size="sm" variant="outline" icon={<RefreshCw size={14} />}>sm</Button>
            <Button size="xs" variant="outline">xs</Button>
            <Button loading variant="secondary">loading</Button>
            <Button disabled>disabled</Button>
          </div>
          <div className="ec-kit-row">
            <IconButton label="Refresh" icon={<RefreshCw size={16} />} />
            <IconButton label="Light" icon={<Zap size={16} />} variant="outline" active />
            <IconButton label="Delete" icon={<Trash2 size={16} />} variant="outline" size="sm" />
            <IconButton label="Download" icon={<Download size={16} />} variant="primary" />
            <CopyButton value="sk-example-copy-value" label="Copy" />
          </div>
        </Section>

        <Section title={SAMPLE.status}>
          <div className="ec-kit-row">{STATUS_ORDER.map((status) => <StatusPill key={status} status={status} />)}</div>
          <div className="ec-kit-row">{STATUS_ORDER.map((status) => <StatusPill key={status} status={status} size="sm" />)}</div>
          <div className="ec-kit-row">
            <Chip>neutral</Chip><Chip tone="ok">ok</Chip><Chip tone="warn">warn</Chip><Chip tone="danger">danger</Chip>
            <Chip tone="info">info</Chip><Chip tone="accent">accent</Chip><Chip tone="outline">outline</Chip>
            <Chip size="sm" onRemove={() => {}}>removable</Chip><Badge>12</Badge><Badge tone="warn" count={3} />
          </div>
        </Section>

        <Section title={SAMPLE.providers}>
          <div className="ec-kit-row">
            {SAMPLE.vendors.map((id) => (
              <span key={id} className="ec-kit-provider"><ProviderLogo provider={id} size={28} /><ProviderName provider={id} /></span>
            ))}
          </div>
          <div className="ec-kit-row">
            {SAMPLE.vendors.slice(0, 6).map((id) => (
              <ProgressBar key={id} value={30 + id.length * 7} color={providerInfo(id).colorVar} label={id} />
            ))}
          </div>
        </Section>

        <Section title={SAMPLE.controls}>
          <div className="ec-kit-row">
            <SegmentedControl ariaLabel="view" value={seg} onChange={setSeg}
              options={[{ value: 'providers', label: 'Providers' }, { value: 'grid', label: 'Grid', count: 4 }, { value: 'timeline', label: 'Timeline' }]} />
            <SegmentedControl size="sm" ariaLabel="range" value="24h" onChange={() => {}}
              options={[{ value: 'today', label: 'Today' }, { value: '24h', label: '24h' }, { value: '7d', label: '7D' }]} />
            <Toggle checked={on} onChange={setOn} label="toggle" />
            <Toggle checked={!on} onChange={(v) => setOn(!v)} label="toggle small" size="sm" />
          </div>
          <Tabs ariaLabel="tabs" idBase="kit" active={tab} onChange={setTab}
            tabs={[{ id: 'one', label: 'Overview' }, { id: 'two', label: 'Requests', count: 24 }, { id: 'three', label: 'Prices' }, { id: 'four', label: 'Off', disabled: true }]} />
          <div {...tabPanelProps('kit', tab)} className="ec-kit-panel"><span className="ec-muted">{tab}</span></div>
          <FilterChips ariaLabel="filter" value={chip} onChange={setChip}
            options={[{ value: 'all', label: 'All', count: 16 }, { value: 'claude', label: 'Claude', count: 2, color: 'var(--ec-p-claude)' }, { value: 'codex', label: 'Codex', count: 4, color: 'var(--ec-p-codex)' }, { value: 'xai', label: 'xAI', count: 2, color: 'var(--ec-p-xai)' }]} />
          <div className="ec-kit-row">
            <div style={{ width: 260 }}><SearchInput value={search} onChange={setSearch} ariaLabel="search" kbdHint="/" /></div>
            <Pagination page={page} pageSize={pageSize} total={96} onPage={setPage} onPageSize={setPageSize} />
          </div>
        </Section>

        <Section title={SAMPLE.data}>
          <div className="ec-kit-stats">
            <StatTile label="Total requests" value="1,783" accent="var(--ec-s1)" hint="24h" trend={<Sparkline values={[2, 4, 3, 6, 5, 8, 7, 9]} />} />
            <StatTile label="Success rate" value="97.7%" accent="var(--ec-st-available)" hint="312 requests" />
            <StatTile label="Est. cost" value="~$9.27" accent="var(--ec-s5)" />
            <StatTile label="Next reset" value={<Countdown to={Date.now() + 5_400_000} />} hint="Claude 5h" onClick={() => {}} />
          </div>
          <QuotaBar leftPct={62} label="5h" /><QuotaBar leftPct={34} label="Week" /><QuotaBar leftPct={8} label="Exhausting" /><QuotaBar leftPct={null} label="Not fetched" />
          <div className="ec-kit-row">
            <span><RelativeTime value={Date.now() - 300_000} /></span>
            <span><RelativeTime value={Date.now() + 7_800_000} /></span>
            <span><Masked value="maya.ortiz@example.dev" kind="identifier" /></span>
            <span><Masked value="claude-maya.ortiz@example.dev.json" kind="text" identities={['maya.ortiz@example.dev']} mono /></span>
          </div>
          <DataTable
            caption="accounts"
            rows={[...SAMPLE.rows]}
            rowKey={(row) => row.id}
            sort={sort}
            onSortChange={setSort}
            onRowClick={() => setPanel(true)}
            columns={[
              { id: 'name', header: 'Account', sortable: true, sortValue: (row) => row.name,
                cell: (row) => <span className="ec-kit-provider"><ProviderLogo provider={row.provider} size={20} /><Masked value={row.name} kind="identifier" /></span> },
              { id: 'left', header: 'Left', sortable: true, sortValue: (row) => row.left, width: 200,
                cell: (row) => <QuotaBar leftPct={row.left} /> },
              { id: 'resets', header: 'Resets', align: 'end', sortable: true, sortValue: (row) => row.resets,
                cell: (row) => (row.resets ? <Countdown to={Date.now() + row.resets} /> : <StatusPill status="notFetched" size="sm" />) },
            ]}
          />
        </Section>

        <Section title={SAMPLE.charts}>
          <ChartLegend items={series.map((entry) => ({ label: entry.label, color: entry.color }))} />
          <AreaChart ariaLabel="tokens" series={series} xLabels={['00', '02', '04', '06', '08', '10', '12', '14', '16', '18', '20', '22']} height={200} />
          <HBar ariaLabel="by provider" rows={[
            { id: 'claude', label: 'Claude', value: 15.9, valueLabel: '15.9M', color: 'var(--ec-p-claude)' },
            { id: 'codex', label: 'Codex', value: 8.2, valueLabel: '8.2M', color: 'var(--ec-p-codex)' },
            { id: 'ag', label: 'Antigravity', value: 3.2, valueLabel: '3.2M', color: 'var(--ec-p-antigravity)' },
          ]} />
        </Section>

        <Section title={SAMPLE.overlays}>
          <div className="ec-kit-row">
            <Button ref={anchor} variant="outline" onClick={() => setPopover((v) => !v)} icon={<Zap size={14} />}>Popover</Button>
            <Button variant="outline" onClick={() => setPanel(true)}>Side panel</Button>
            <Button variant="outline" onClick={() => setDialog(true)}>Dialog</Button>
            <Button variant="danger" onClick={() => setConfirm(true)}>Confirm</Button>
          </div>
          <Popover open={popover} onClose={() => setPopover(false)} anchorRef={anchor} label="demo" width={240}>
            <PopoverHeading>Start window</PopoverHeading>
            <PopoverItem icon={<Zap size={14} />}>Start now</PopoverItem>
            <PopoverItem icon={<Copy size={14} />}>After reset</PopoverItem>
            <PopoverSeparator />
            <PopoverItem danger icon={<Trash2 size={14} />}>Remove</PopoverItem>
          </Popover>
          <SidePanel open={panel} onClose={() => setPanel(false)} title="Account detail" subtitle="side panel"
            footer={<Button variant="primary" onClick={() => setPanel(false)}>Done</Button>}>
            <QuotaBar leftPct={62} label="5h" /><Skeleton lines={3} />
          </SidePanel>
          <Dialog open={dialog} onClose={() => setDialog(false)} title="Dialog" footer={<Button onClick={() => setDialog(false)}>Close</Button>}>
            <Skeleton lines={2} />
          </Dialog>
          <ConfirmDialog open={confirm} title="Delete credential?" message="This cannot be undone." danger onConfirm={() => setConfirm(false)} onCancel={() => setConfirm(false)} />
        </Section>

        <Section title={SAMPLE.states}>
          <div className="ec-kit-states">
            <EmptyState icon={<Plus size={22} />} title="No accounts yet" action={<Button size="sm" variant="primary">Add account</Button>} />
            <ErrorState message="Fetch failed" onRetry={() => {}} />
            <div><Skeleton height={16} width="60%" /><Skeleton lines={3} /></div>
          </div>
        </Section>
      </div>
    </>
  );
}
