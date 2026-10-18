import { useRef, useState } from 'react';
import { invoke } from '../services/platform';
import { Check, ExternalLink, MessageCircle, SlidersHorizontal } from 'lucide-react';
import { languageOptions, useI18n } from '../i18n';
import { useThemePreference } from '../theme';
import { themePreview, themeRegistry } from '../themes/registry';
import { useDensity, type Density } from '../density';
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
              <span className="ec-theme-name">{t(candidate.nameKey)}</span>
            </button>
          );
        })}
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
