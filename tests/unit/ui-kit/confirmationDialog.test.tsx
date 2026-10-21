import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmationDialog } from '../../../src/components/ConfirmationDialog';
import { I18nProvider } from '../../../src/i18n';

describe('application confirmation', () => {
  it('renders an accessible in-app confirmation with explicit reset and cancel actions', () => {
    const html = renderToStaticMarkup(<I18nProvider><ConfirmationDialog title="Reset Quota" message="Reset the test account quota?" confirmText="Confirm Reset" warning="This consumes one reset credit" onDecision={() => {}} /></I18nProvider>);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('Confirm Reset');
    expect(html).toContain('Cancel');
    expect(html).toContain('This consumes one reset credit');
  });
});
