import { useMemo } from 'react';
import { RoutingCandidates } from './RoutingCandidates';
import {
  buildGroups, fetchCredentials, fetchEvents, fetchPolicy, serveCounts, useBlock,
} from './RoutingData';
import { RoutingPolicy } from './RoutingPolicy';
import { RoutingStream } from './RoutingStream';
import { useUsage } from './UsageContext';
import './Routing.css';

/** Usage → live routing: policy strip, candidate accounts per provider, live request stream. Three independent data blocks. */
export function RoutingTab() {
  const { refreshVersion, manualVersion } = useUsage();
  const policy = useBlock(fetchPolicy, manualVersion);
  // Credentials load on mount/manual refresh; cooldown expiry can request its own reload.
  const credentials = useBlock(fetchCredentials, manualVersion);
  const events = useBlock(fetchEvents, refreshVersion);
  const groups = useMemo(() => buildGroups(credentials.data), [credentials.data]);
  const served = useMemo(() => serveCounts(events.data?.items ?? [], groups).byAuthIndex, [events.data, groups]);
  return (
    <div className="rt">
      <RoutingPolicy block={policy} />
      <div className="rt-cols">
        <RoutingCandidates block={credentials} groups={groups} served={served} onCooldownDone={credentials.reload} />
        <RoutingStream block={events} groups={groups} />
      </div>
    </div>
  );
}
