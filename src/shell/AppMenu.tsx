import { useRef, useState } from 'react';
import { invoke } from '../services/platform';
import { Check, ExternalLink, FolderOpen, MessageCircle, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { languageOptions, useI18n } from '../i18n';
import { openCustomThemesDirectory, reloadCustomThemes, useCustomThemeStatus, useThemePreference, useThemeRegistry } from '../theme';
import { themePreview } from '../themes/registry';
import { localizeThemeLabel } from '../themes/types';
import { useDensity, type Density } from '../density';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Popover, PopoverHeading, PopoverItem, PopoverSeparator } from '../ui/Popover';
import { SegmentedControl } from '../ui/SegmentedControl';
import './Appearance.css';

const QQ_CONTACT_URL = 'https://qm.qq.com/q/3queDaIG';
const DISCORD_SERVER_URL = 'https://discord.gg/PxvX4D9kgs';

/**
 * Theme · density · language controls. Reused by Settings → App (`<AppearanceControls/>`);
 * the sidebar footer shows them in a popover for quick access.
 */
export function AppearanceControls() {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useThemePreference();
  // The live registry includes custom theme files (upstream #481); they share the --ec-* bridge.
  const themeRegistry = useThemeRegistry();
  const custom = useCustomThemeStatus();
  const [openFailed, setOpenFailed] = useState(false);
  const customText = [
    openFailed ? t('app.theme.custom.openFailed') : '',
    custom.failed ? t('app.theme.custom.loadFailed') : '',
    custom.skipped.length ? t('app.theme.custom.skipped', { files: custom.skipped.join(', ') }) : '',
    custom.omitted ? t('app.theme.custom.omitted', { count: custom.omitted }) : '',
  ].filter(Boolean).join(' ');
  const [density, setDensity] = useDensity();
  return (
    <div className="ec-appearance">
      <PopoverHeading>{t('shell.theme')}</PopoverHeading>
      <SegmentedControl
        ariaLabel={t('shell.theme')}
        value={theme}
        onChange={(value) => setTheme(value)}
        options={[
          { value: 'dark', label: t('shell.theme.dark') },
          { value: 'light', label: t('shell.theme.light') },
          { value: 'system', label: t('shell.theme.system') },
        ]}
      />
      <PopoverHeading>{t('shell.theme.more')}</PopoverHeading>
      <div className="ec-theme-list" role="group" aria-label={t('shell.theme.more')}>
        {themeRegistry.themes.filter((candidate) => candidate.id !== 'dark' && candidate.id !== 'light').map((candidate) => {
          const preview = themePreview(candidate);
          return (
            <button
              key={candidate.id}
              type="button"
              className="ec-theme-card"
              data-theme-id={candidate.id}
              aria-pressed={theme === candidate.id}
              onClick={() => setTheme(candidate.id)}
            >
              <span className="ec-theme-swatch" aria-hidden="true" style={{ background: preview.background }}>
                <i style={{ background: preview.sidebar }} />
                <i style={{ background: preview.surface }} />
                <i style={{ background: preview.accent }} />
              </span>
              <span className="ec-theme-name">{candidate.name ? localizeThemeLabel(candidate.name, locale) : t(candidate.nameKey!)}</span>
            </button>
          );
        })}
      </div>
      {customText ? <p className="ec-theme-custom-notice" role="status">{customText}</p> : null}
      <div className="ec-theme-custom-actions">
        <Button size="xs" variant="ghost" icon={<FolderOpen size={12} />} data-action="open-themes"
          onClick={() => { setOpenFailed(false); openCustomThemesDirectory().catch(() => setOpenFailed(true)); }}>
          {t('app.theme.custom.openFolder')}
        </Button>
        <Button size="xs" variant="ghost" icon={<RefreshCw size={12} />} data-action="reload-themes" disabled={custom.loading}
          onClick={() => { setOpenFailed(false); void reloadCustomThemes(); }}>
          {t('app.theme.custom.reload')}
        </Button>
      </div>
      <PopoverHeading>{t('shell.density')}</PopoverHeading>
      <SegmentedControl<Density>
        ariaLabel={t('shell.density')}
        value={density}
        onChange={setDensity}
        options={[
          { value: 'comfortable', label: t('shell.density.comfortable') },
          { value: 'compact', label: t('shell.density.compact') },
        ]}
      />
      <PopoverHeading>{t('app.language')}</PopoverHeading>
      <div role="listbox" aria-label={t('app.language')}>
        {languageOptions.map((option) => (
          <PopoverItem key={option.value} onClick={() => setLocale(option.value)}
            icon={option.value === locale ? <Check size={14} /> : <span style={{ width: 14 }} />}>
            <span lang={option.value}>{option.nativeLabel}</span>
          </PopoverItem>
        ))}
      </div>
    </div>
  );
}

/** Footer button that opens appearance + language + contact. */
export function AppMenu() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const openContact = async () => {
    try {
      await invoke('open_external_url', { url: locale === 'zh-CN' ? QQ_CONTACT_URL : DISCORD_SERVER_URL });
    } catch (error) {
      console.error('Failed to open the contact link', error);
    }
  };
  return (
    <>
      <IconButton ref={anchor} label={t('shell.appearance')} icon={<SlidersHorizontal size={15} />}
        active={open} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} side="bottom" align="start" width={260} label={t('shell.appearance')}>
        <AppearanceControls />
        <PopoverSeparator />
        <PopoverItem icon={<MessageCircle size={15} />} onClick={() => void openContact()}>
          {t('app.contact.label')} <ExternalLink size={12} />
        </PopoverItem>
      </Popover>
    </>
  );
}
