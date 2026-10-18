import { useRef, useState, type RefObject } from 'react';
import { ChevronDown, FileUp, KeyRound, Plus } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Popover, PopoverHeading, PopoverItem, PopoverSeparator, ProviderLogo } from '../../ui';
import type { ProviderCategory } from './api';
import type { SignInProvider } from './signin';

export type AddMenuApiKind = { id: ProviderCategory; brand: string; label: string };

/** Page-level "Add ▾": sign in with a subscription, add an API key, or import credential files. */
export function AddMenu({ signIn, kinds, onSignIn, onAddKey, onImport }: {
  signIn: readonly SignInProvider[];
  kinds: readonly AddMenuApiKind[];
  onSignIn: (id: string) => void;
  onAddKey: (kind: ProviderCategory) => void;
  onImport: () => void;
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => () => { setOpen(false); action(); };
  return (
    <>
      <span ref={anchor as unknown as RefObject<HTMLSpanElement>} className="pv-add-anchor">
        <Button variant="primary" size="sm" icon={<Plus size={14} />} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="providers-add">
          {t('sec.providers.action.add')}<ChevronDown size={13} aria-hidden="true" />
        </Button>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor as unknown as RefObject<HTMLElement>} align="end" width={280} label={t('sec.providers.action.add')}>
        <PopoverHeading>{t('sec.providers.add.signIn')}</PopoverHeading>
        {signIn.map((provider) => (
          <PopoverItem key={provider.id} icon={<ProviderLogo provider={provider.brand} size={18} />} disabled={Boolean(provider.disabledReason)} onClick={pick(() => onSignIn(provider.id))}>
            <span title={provider.disabledReason}>{provider.name}{provider.disabledReason ? <small className="pv-menu-reason"> · {provider.disabledReason}</small> : null}</span>
          </PopoverItem>
        ))}
        <PopoverSeparator />
        <PopoverHeading>{t('sec.providers.add.apiKey')}</PopoverHeading>
        {kinds.map((kind) => (
          <PopoverItem key={kind.id} icon={<ProviderLogo provider={kind.brand} size={18} />} onClick={pick(() => onAddKey(kind.id))}>
            {kind.label}
          </PopoverItem>
        ))}
        <PopoverSeparator />
        <PopoverItem icon={<FileUp size={15} />} onClick={pick(onImport)}>{t('sec.providers.action.import')}</PopoverItem>
      </Popover>
    </>
  );
}

/** Small picker used by a card whose brand has several API-key kinds (Gemini, …); a single kind opens directly. */
export function KindMenu({ open, anchorEl, kinds, onClose, onPick }: {
  open: boolean;
  anchorEl: HTMLElement | null;
  kinds: readonly AddMenuApiKind[];
  onClose: () => void;
  onPick: (kind: ProviderCategory) => void;
}) {
  const { t } = useI18n();
  const ref = { current: anchorEl } as RefObject<HTMLElement>;
  return (
    <Popover open={open && Boolean(anchorEl)} onClose={onClose} anchorRef={ref} width={240} label={t('sec.providers.add.apiKey')}>
      {kinds.map((kind) => (
        <PopoverItem key={kind.id} icon={<KeyRound size={15} />} onClick={() => { onClose(); onPick(kind.id); }}>{kind.label}</PopoverItem>
      ))}
    </Popover>
  );
}
