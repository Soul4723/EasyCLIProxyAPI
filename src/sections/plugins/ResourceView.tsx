import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Button } from '../../ui';
import type { PluginsController } from './usePlugins';

/** A plugin's own resource page (menu entry) shown inline in a sandboxed frame; replaces the tab content until closed. */
export function ResourceView({ ctl }: { ctl: PluginsController }) {
  const { resource, pt } = ctl;
  if (!resource) return null;
  return (
    <section className="pl-resource">
      <div className="pl-resource-bar">
        <Button size="sm" variant="secondary" icon={<ArrowLeft size={14} />} onClick={() => ctl.setResource(null)}>{pt('back')}</Button>
        <strong className="ec-trunc">{resource.entry.label}</strong>
        <span className="pl-spacer" />
        <Button size="sm" variant="secondary" icon={<ExternalLink size={14} />} onClick={() => ctl.openExternal(resource.url)}>{pt('openExternal')}</Button>
      </div>
      <iframe key={resource.url} src={resource.url} title={resource.entry.label} referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups" allow="clipboard-read; clipboard-write" />
    </section>
  );
}
