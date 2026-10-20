// First on purpose: the legacy globals sit below every component stylesheet that the imports after it pull in.
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { listen } from './services/platform';
import { documentTarget } from './services/documentTarget';
import { isTauri } from './services/platform';
import { AppErrorBoundary } from './AppErrorBoundary';
import App from './App';
import { I18nProvider } from './i18n';
import { initializeTheme, initializeThemePreferences } from './theme';
import { initializeUsagePreferences } from './services/usagePreferences';
import { initializePrivacyMode } from './privacy';
import { initializeDensity } from './density';
import { startAgentBriefing } from './sections/quota/agentBriefing';
import './ui/index.css';

async function bootstrap() {
  await Promise.all([initializeUsagePreferences(), initializeThemePreferences().then(() => initializeTheme()), initializePrivacyMode()]);
  if (import.meta.env.DEV && !isTauri()) {
    const { installBrowserMock } = await import('./mocks/browserMock');
    installBrowserMock();
  }

  // Subscribe before capturing so a concurrent native switch cannot leave this document active.
  await listen('core-connection-changed', () => {
    documentTarget.block();
    window.location.reload();
  });
  await documentTarget.getRevision();
  initializeTheme();
  initializeDensity();
  // Native app only: the browser mock has no briefing command and nothing reads its cache.
  if (isTauri()) startAgentBriefing();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </I18nProvider>
    </StrictMode>,
  );
}

void bootstrap();
