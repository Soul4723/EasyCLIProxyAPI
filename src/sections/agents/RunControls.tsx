import { AppWindow, Play, RefreshCw, Square, Terminal } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Chip } from '../../ui';
import type { AgentLaunchTarget } from './model';
import type { AgentsController } from './useAgentsController';

/** Launch / stop / restart controls for the open client (header of the detail page). */
export function RunControls({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const { selected, activeDefinition, activeLaunchTargets: targets, launchEnabled: enabled, busyAction, busy } = ctl;
  const dual = ctl.hasIndependentCliAndApp;
  const harness = ctl.isDeepSeekHarnessClient ? ctl.deepSeekHarnessProcessStatus : null;
  const desktop = (dual && !ctl.isDeepSeekHarnessClient) || ['claude-desktop', 'zcode', 'workbuddy'].includes(selected);
  const cli = targets.find((target) => target.id === 'cli') ?? null;
  const app = targets.find((target) => target.id === 'app') ?? null;
  const launch = (target: AgentLaunchTarget | null, kind?: 'cli' | 'app') => {
    const starting = busyAction === (dual ? `launch-${kind}` : 'launch');
    return (
      <Button key={kind ?? 'launch'} variant="secondary" loading={starting} data-action={kind ? `launch-${kind}` : 'launch'}
        icon={target?.id === 'cli' ? <Terminal size={14} /> : target?.id === 'app' ? <AppWindow size={14} /> : <Play size={14} />}
        disabled={busy || !enabled || !target || (ctl.cliServiceRestarting && target.id === 'cli')}
        title={target?.detail ?? t('agents.launch.unavailable')} onClick={() => void ctl.launchAgent(target)}>
        {starting ? t('agents.launch.starting')
          : kind ? t(kind === 'cli' ? 'agents.launch.startCli' : 'agents.launch.startApp')
          : t('agents.launch.start', { target: target?.label ?? activeDefinition.name })}
      </Button>
    );
  };
  return (
    <div className="ag-run" role="group" aria-label={t('agents.run.title')}>
      {harness?.running ? (
        <Chip tone="ok" size="sm" icon={<span className="ag-dot" />}>
          {t('agents.deepseekLaunch.runningDetail', { pid: harness.pid ?? '—', mode: harness.mode ?? '—' })}
        </Chip>
      ) : null}
      {selected === 'codex' ? (
        <Button variant="secondary" loading={ctl.cliServiceRestarting} icon={<RefreshCw size={14} />}
          disabled={busy || ctl.cliServiceRestarting || !enabled || !cli}
          title={ctl.cliServiceRestarting ? t('agents.launch.restartingCliDetail') : cli?.detail ?? t('agents.launch.unavailable')}
          onClick={() => void ctl.restartCodexCliService()}>
          {t(ctl.cliServiceRestarting ? 'agents.launch.restartingCli' : 'agents.launch.restartCli')}
        </Button>
      ) : null}
      {harness?.running
        ? <Button variant="danger" loading={busyAction === 'stop-deepseek'} icon={<Square size={14} />} disabled={busy}
            onClick={() => void ctl.stopDeepSeekHarness()}>
            {t(busyAction === 'stop-deepseek' ? 'agents.deepseekLaunch.stopping' : 'agents.deepseekLaunch.stop')}
          </Button>
        : dual ? launch(cli, 'cli') : launch(targets[0] ?? null)}
      {dual ? launch(app, 'app') : null}
      {desktop ? (
        <Button variant="secondary" loading={busyAction === 'restart-app'} icon={<RefreshCw size={14} />}
          disabled={busy || !enabled || !app} title={app?.detail ?? t('agents.launch.unavailable')}
          onClick={() => void ctl.restartDesktopApp()}>
          {t(busyAction === 'restart-app' ? 'agents.launch.restartingApp' : 'agents.launch.restartApp')}
        </Button>
      ) : null}
      {harness?.running && harness.mode === 'web' ? (
        <Button variant="secondary" loading={busyAction === 'restart-deepseek'} icon={<RefreshCw size={14} />} disabled={busy}
          onClick={() => void ctl.restartDeepSeekHarness()}>
          {t(busyAction === 'restart-deepseek' ? 'agents.deepseekLaunch.restarting' : 'agents.deepseekLaunch.restart')}
        </Button>
      ) : null}
    </div>
  );
}
