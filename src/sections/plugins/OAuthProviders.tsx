import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../services/platform';
import { LogIn, RefreshCw } from 'lucide-react';
import { useI18n } from '../../i18n';
import { pluginOAuthText } from '../../i18n/pluginOAuth';
import { pluginsApi, type PluginListEntry } from '../../services/plugins';
import { collectPluginOAuthProviders } from '../../services/pluginOAuthProviders';
import { getPluginTitle, PLUGIN_RESOURCES_REFRESH_EVENT } from '../../services/pluginResources';
import { Button, Card, Chip, Masked } from '../../ui';
import { OAuthDialog } from './OAuthDialog';
import { Banner, PluginTile, Scope } from './parts';

/**
 * Sign-in cards for plugin-provided OAuth providers (the old PluginOAuthProviders, same loading/retry rules): one card per
 * running plugin that declares a provider not already built in. Meant for the Providers → OAuth page.
 * Props: builtInProviderIds (provider ids already handled elsewhere), browser? (browser choice passed to the dialog).
 */
export function PluginOAuthProviders({ builtInProviderIds, browser = 'default' }: {
  builtInProviderIds: readonly string[];
  browser?: string;
}) {
  const { t, locale } = useI18n();
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  const retryTimer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    window.clearTimeout(retryTimer.current);
    const current = ++revision.current;
    setLoading(true);
    setError(false);
    const active = () => mounted.current && current === revision.current;
    const refresh = async (attempt: number) => {
      try {
        if (attempt === 0) {
          const supported = await invoke<boolean>('get_plugin_support');
          if (!active()) return;
          if (!supported) {
            setPlugins([]);
            setSelectedProvider(null);
            return;
          }
        }
        const response = await pluginsApi.list();
        if (!active()) return;
        const next = response.pluginsEnabled
          ? collectPluginOAuthProviders(response.plugins, builtInProviderIds) : [];
        setPlugins(next);
        setSelectedProvider(previous => next.some(plugin => plugin.oauthProvider === previous) ? previous : null);
        // Installation can finish before the core registers the plugin. Keep following
        // that transition even if the user has already left the plugin manager.
        if (attempt < 8 && response.pluginsEnabled
          && response.plugins.some(plugin => plugin.path && plugin.enabled && !plugin.effectiveEnabled)) {
          retryTimer.current = window.setTimeout(() => {
            if (active()) void refresh(attempt + 1);
          }, 1500);
        }
      } catch {
        if (active()) {
          setPlugins([]);
          setSelectedProvider(null);
          setError(true);
        }
      } finally {
        if (active()) setLoading(false);
      }
    };
    return refresh(0);
  }, [builtInProviderIds]);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => { void load(); };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, refresh);
    return () => {
      mounted.current = false;
      ++revision.current;
      window.clearTimeout(retryTimer.current);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, refresh);
    };
  }, [load]);

  const selectedPlugin = plugins.find(plugin => plugin.oauthProvider === selectedProvider);
  return (
    <Scope>
      {error ? (
        <Banner tone="error" action={<Button size="xs" variant="secondary" loading={loading} icon={<RefreshCw size={12} />} onClick={() => void load()}>{t('common.refresh')}</Button>}>
          {pluginOAuthText('loadFailed', locale)}
        </Banner>
      ) : null}
      {plugins.map(plugin => {
        const provider = plugin.oauthProvider!;
        const authorized = completed.has(provider);
        return (
          <Card as="section" key={provider}>
            <div className="pl-card-head">
              <PluginTile />
              <div className="pl-id">
                <strong className="ec-trunc">{pluginOAuthText('providerTitle', locale).replace('{name}', getPluginTitle(plugin))}</strong>
                <Masked value={plugin.id} kind="identifier" mono className="pl-id-code ec-trunc" />
              </div>
              {authorized ? <Chip size="sm" tone="ok">{t('oauth.status.completed')}</Chip> : null}
              <Button variant="primary" size="sm" icon={<LogIn size={14} />} onClick={() => setSelectedProvider(provider)}>
                {t(authorized ? 'oauth.loginAnother' : 'oauth.startLogin')}
              </Button>
            </div>
          </Card>
        );
      })}
      {selectedPlugin ? (
        <OAuthDialog key={selectedPlugin.oauthProvider} plugin={selectedPlugin} browser={browser}
          onClose={() => setSelectedProvider(null)}
          onCompleted={() => setCompleted(previous => new Set(previous).add(selectedPlugin.oauthProvider!))} />
      ) : null}
    </Scope>
  );
}
