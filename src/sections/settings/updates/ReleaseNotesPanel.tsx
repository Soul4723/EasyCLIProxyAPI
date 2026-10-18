// Collapsible release notes for the latest app release (markdown, current language) — same data and link handling as AppReleaseNotes.
import { useId, useState } from 'react';
import { ChevronDown, ExternalLink, FileText } from 'lucide-react';
import Markdown from 'react-markdown';
import type { AppUpdateInfo } from '../../../appUpdate';
import { useI18n } from '../../../i18n';
import { Button, Card, Chip } from '../../../ui';
import { releaseNotesUrl } from '../../../components/AppReleaseNotes';
import { displayAppVersion } from './model';

export function ReleaseNotesPanel({ info, checking, failed, onOpenUrl }: {
  info: Pick<AppUpdateInfo, 'latestVersion' | 'releaseNotes' | 'publishedAt'> | null;
  checking: boolean; failed: boolean; onOpenUrl: (url?: string) => void | Promise<void>;
}) {
  const { t, formatDate, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const notes = info?.releaseNotes?.[locale]?.trim();
  const publishedAt = info?.publishedAt && Number.isFinite(Date.parse(info.publishedAt)) ? info.publishedAt : null;
  const emptyMessage = info ? t('appUpdate.notes.empty')
    : checking ? t('appUpdate.notes.loading')
      : failed ? t('appUpdate.notes.failed') : t('appUpdate.notes.notChecked');

  return (
    <Card as="section" padded={false} className="ec-upd-notes" aria-label={t('appUpdate.notes.title')}>
      <button type="button" className="ec-upd-notes-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((current) => !current)}>
        <FileText size={15} aria-hidden="true" />
        <h3>{t('appUpdate.notes.title')}</h3>
        {info ? <Chip size="sm" tone="accent">{displayAppVersion(info.latestVersion)}</Chip> : null}
        {publishedAt ? <time className="ec-upd-notes-date" dateTime={publishedAt}>{formatDate(publishedAt, { year: 'numeric', month: 'short', day: 'numeric' })}</time> : null}
        <span className="ec-set-spacer" />
        <span className="ec-upd-notes-label">{t(expanded ? 'appUpdate.notes.collapse' : 'appUpdate.notes.expand')}</span>
        <ChevronDown size={15} className={`ec-upd-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true" />
      </button>
      <div id={bodyId} hidden={!expanded} className="ec-upd-notes-body">
        {notes ? (
          <div className="ec-upd-markdown" lang={locale}>
            <Markdown
              skipHtml
              disallowedElements={['img']}
              urlTransform={releaseNotesUrl}
              components={{
                h1: ({ children }) => <h4>{children}</h4>,
                h2: ({ children }) => <h4>{children}</h4>,
                a: ({ href, children }) => href ? (
                  <a href={href} onClick={(event) => { event.preventDefault(); void onOpenUrl(href); }}>{children}</a>
                ) : <span>{children}</span>,
              }}
            >
              {notes}
            </Markdown>
          </div>
        ) : (
          <p className="ec-upd-notes-empty" role="status">{emptyMessage}</p>
        )}
        <Button size="sm" variant="ghost" icon={<ExternalLink size={14} />} onClick={() => void onOpenUrl()}>{t('appUpdate.notes.openRelease')}</Button>
      </div>
    </Card>
  );
}
