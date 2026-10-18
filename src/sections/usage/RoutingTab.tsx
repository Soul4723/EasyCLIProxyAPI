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
  const { tick } = useUsage();
  const policy = useBlock(fetchPolicy, 0);
  // Credentials carry cooldowns; refetch about every 15s (Countdown onDone also triggers a reload).
  const credentials = useBlock(fetchCredentials, Math.floor(tick / 5));
  const events = useBlock(fetchEvents, tick);
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
