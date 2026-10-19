import { useMemo } from 'react';
import { RoutingCandidates } from './RoutingCandidates';
import {
  buildGroups, fetchEvents, usePolicyBlock, serveCounts, useBlock, useCredentialsBlock,
} from './RoutingData';
import { RoutingPolicy } from './RoutingPolicy';
import { RoutingStream } from './RoutingStream';
import { useUsage } from './UsageContext';
import './Routing.css';

/** Usage → routing: policy strip, candidate accounts per provider, request stream. Three independent data blocks. */
export function RoutingTab() {
  const { refreshVersion, manualVersion, collection } = useUsage();
  const policy = usePolicyBlock(manualVersion);
  // Credentials load on mount/manual refresh; cooldown expiry can request its own reload.
  const credentials = useCredentialsBlock(manualVersion);
  const events = useBlock(fetchEvents, refreshVersion);
  const groups = useMemo(() => buildGroups(credentials.data), [credentials.data]);
  const served = useMemo(() => serveCounts(events.data?.items ?? [], groups).byAuthIndex, [events.data, groups]);
  return (
    <div className="rt">
      <RoutingPolicy block={policy} />
      <div className="rt-cols">
        <RoutingCandidates block={credentials} groups={groups} served={served} onCooldownDone={credentials.reload} stale={collection.coreDown ? collection.kind === 'unreachable' ? 'unreachable' : 'stopped' : null} />
        <RoutingStream block={events} groups={groups} />
      </div>
    </div>
  );
}
