import type { AgentDefinition } from './model';
import { Bot } from 'lucide-react';

/** Client logo tile (agent clients are not providers, so ProviderLogo does not apply). Decorative: the name is always shown next to it. */
export function ClientLogo({ definition, size = 32 }: { definition: AgentDefinition; size?: number }) {
  const Icon = definition.Icon ?? Bot;
  return (
    <span className="ag-logo" style={{ width: size, height: size }} aria-hidden>
      {definition.icon
        ? <img src={definition.icon} alt="" draggable={false} style={{ width: size * 0.62, height: size * 0.62 }} />
        : <Icon size={Math.round(size * 0.58)} aria-hidden />}
    </span>
  );
}
