import { ChevronDown, ChevronRight, Download, ExternalLink, FileText, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import {
  Badge, Button, CopyButton, formatBytes, ErrorState, FilterChips, IconButton, Masked, RelativeTime, SearchInput, SidePanel, Skeleton, Toggle,
  type FilterOption,
} from '../../../ui';
import { MessageBlock, RoleIcon, useRoleLabel } from './MessageBlock';
import { SessionNotice } from './SessionNotice';
import { useSessionContext, type RoleFilter } from './useSessionContext';

type SessionEditorProps = {
  sessionId: string;
  /** Title shown while the detail is still loading (from the list row). */
  fallbackTitle: string;
  onClose: () => void;
  onSessionUpdated: () => void;
};

/**
 * Context editor for one Codex session, in a wide SidePanel: role-tagged message blocks with role/search filters,
 * per-message edit/remove, appended messages, metadata fields, Save (backed up by the backend), Open rollout file and
 * JSONL export. Unsaved changes ask before the panel closes; the prompt is inline because a modal cannot stack on the panel.
 */
export function SessionEditor({ sessionId, fallbackTitle, onClose, onSessionUpdated }: SessionEditorProps) {
  const { t, formatNumber } = useI18n();
  const roleLabel = useRoleLabel();
  const ctl = useSessionContext({ sessionId, onClose, onSessionUpdated });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { detail, loading, saving } = ctl;
  const untitled = t('agents.sessions.untitled');
  const stats = detail?.stats;

  const roleOptions: FilterOption<RoleFilter>[] = [
    { value: 'all', label: t('agents.sessions.context.filterAll'), count: ctl.totalMessages },
    { value: 'user', label: t('agents.sessions.context.userRole'), count: stats?.userMessageCount ?? 0, icon: <RoleIcon role="user" size={12} /> },
    { value: 'assistant', label: t('agents.sessions.context.assistantRole'), count: stats?.assistantMessageCount ?? 0, icon: <RoleIcon role="assistant" size={12} /> },
    { value: 'reasoning', label: t('agents.sessions.context.reasoningRole'), count: stats?.reasoningCount ?? 0, icon: <RoleIcon role="reasoning" size={12} /> },
    { value: 'tool', label: t('agents.sessions.context.toolRole'), count: stats?.toolCount ?? 0, icon: <RoleIcon role="tool" size={12} /> },
  ];

  const fields = [
    { id: 'title', label: t('agents.sessions.context.sessionTitle'), value: ctl.title, set: ctl.setTitle, placeholder: untitled },
    { id: 'cwd', label: t('agents.sessions.context.workspace'), value: ctl.cwd, set: ctl.setCwd, placeholder: t('agents.sessions.context.workspacePlaceholder') },
    { id: 'model', label: t('agents.sessions.context.model'), value: ctl.model, set: ctl.setModel, placeholder: t('agents.sessions.context.modelPlaceholder') },
    { id: 'provider', label: t('agents.sessions.context.provider'), value: ctl.modelProvider, set: ctl.setModelProvider, placeholder: t('agents.sessions.context.providerPlaceholder') },
  ];

  const footer = ctl.discardOpen ? (
    <div className="ec-sec-agents">
      <div className="ses-foot ses-foot--discard" role="alertdialog" aria-label={t('agents.sessions.context.discardTitle')}>
        <span className="ses-foot-msg">{t('agents.sessions.context.confirmDiscard')}</span>
        <Button variant="secondary" size="sm" onClick={() => ctl.setDiscardOpen(false)}>{t('sec.agents.sessions.keepEditing')}</Button>
        <Button variant="danger" size="sm" onClick={ctl.confirmDiscard}>{t('agents.sessions.context.discard')}</Button>
      </div>
    </div>
  ) : (
    <div className="ec-sec-agents">
      <div className="ses-foot">
        <span className="ses-foot-msg ec-muted">
          {ctl.isDirty ? <Badge tone="accent">{t('sec.agents.sessions.changes', { count: ctl.changeCount })}</Badge> : null}
          <span className="ec-trunc">{t('sec.agents.sessions.backupNote')}</span>
        </span>
        <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={loading || !ctl.isDirty} onClick={() => void ctl.save()}>
          {saving ? t('agents.sessions.context.saving') : t('agents.sessions.context.saveChanges')}
        </Button>
      </div>
    </div>
  );

  return (
    <SidePanel
      open
      width={820}
      onClose={ctl.requestClose}
      title={<Masked value={ctl.title || fallbackTitle || untitled} />}
      subtitle={(
        <span className="ec-sec-agents"><span className="ses-sub">
          <Masked kind="identifier" mono value={sessionId} />
          {detail?.updatedAtMs ? <RelativeTime value={detail.updatedAtMs} /> : null}
        </span></span>
      )}
      actions={(
        <>
          <IconButton label={t('agents.sessions.context.reload')} icon={<RefreshCw size={14} className={loading ? 'ses-spin' : ''} />}
            disabled={loading || saving || ctl.isDirty} onClick={() => void ctl.loadContext()} />
          <IconButton label={t('agents.sessions.context.exportJsonl')} icon={<Download size={14} />}
            disabled={loading || saving || ctl.isDirty || !detail?.rawJsonlAvailable || !detail.rawJsonl} onClick={ctl.exportJsonl} />
          <Button size="sm" variant="secondary" icon={<ExternalLink size={13} />} loading={ctl.opening}
            title={detail && !detail.rolloutPath ? t('sec.agents.sessions.rolloutMissing') : ctl.isDirty ? t('sec.agents.sessions.dirtyBlocked') : t('agents.sessions.context.externalEditNotice')}
            disabled={loading || saving || ctl.isDirty || !detail?.rolloutPath} onClick={() => void ctl.openRollout()}>
            {t('sec.agents.sessions.openRollout')}
          </Button>
        </>
      )}
      footer={footer}
    >
      <div className="ses-editor ec-sec-agents">
        {ctl.notice ? <SessionNotice kind={ctl.notice.kind} message={ctl.notice.message} onDismiss={() => ctl.setNotice(null)} /> : null}
        {loading ? (
          <div className="ses-editor-skel" aria-busy="true">
            <Skeleton height={34} />
            <Skeleton height={86} />
            <Skeleton height={86} />
            <Skeleton height={86} />
          </div>
        ) : !detail ? (
          <ErrorState title={t('sec.agents.sessions.editorLoadError')} message={ctl.loadError ? <Masked value={ctl.loadError} /> : undefined}
            onRetry={() => void ctl.loadContext()} />
        ) : (
          <>
            <p className="ses-safety">{t('agents.sessions.context.editSafety')}</p>

            <section className="ses-details">
              <button type="button" className="ses-details-head" aria-expanded={detailsOpen} aria-controls="ses-details-body"
                aria-label={t('agents.sessions.context.toggleMetadata')} onClick={() => setDetailsOpen((open) => !open)}>
                {detailsOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                <strong>{t('sec.agents.sessions.details')}</strong>
                <span className="ses-details-stats ec-muted ec-num">
                  {t('sec.agents.sessions.stat.messages', { count: formatNumber(stats?.messageCount ?? 0) })}
                  {' · '}{t('sec.agents.sessions.stat.lines', { count: formatNumber(stats?.totalLines ?? 0) })}
                  {' · '}{formatBytes(stats?.fileSizeBytes ?? 0)}
                </span>
              </button>
              {detailsOpen ? (
                <div className="ses-details-body" id="ses-details-body">
                  <div className="ses-fields">
                    {fields.map((field) => (
                      <label key={field.id} className="ses-field">
                        <span>{field.label}</span>
                        <input type="text" className="ses-input" value={field.value} disabled={saving} placeholder={field.placeholder}
                          onChange={(event) => field.set(event.target.value)} />
                      </label>
                    ))}
                  </div>
                  <div className="ses-paths">
                    <div className="ses-path">
                      <FileText size={13} aria-hidden />
                      <span className="ec-muted">{t('agents.sessions.context.rolloutPath')}</span>
                      {detail.rolloutPath ? (
                        <>
                          <Masked as="code" kind="identifier" mono className="ec-trunc" value={detail.rolloutPath} />
                          <CopyButton value={detail.rolloutPath} size="sm" />
                        </>
                      ) : <span className="ec-muted">—</span>}
                    </div>
                    <div className="ses-path">
                      <FileText size={13} aria-hidden />
                      <span className="ec-muted">{t('agents.sessions.context.dbPath')}</span>
                      {detail.databasePath ? <Masked as="code" kind="identifier" mono className="ec-trunc" value={detail.databasePath} /> : <span className="ec-muted">—</span>}
                    </div>
                    <div className="ses-path ses-path--toggle">
                      <Toggle size="sm" label={t('agents.sessions.context.archived')} checked={ctl.archived}
                        disabled={saving || !detail.rolloutPath} onChange={ctl.setArchived} />
                      <span>{ctl.archived ? t('agents.sessions.context.isArchived') : t('agents.sessions.context.isNotArchived')}</span>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            <div className="ses-filter-row">
              <FilterChips ariaLabel={t('agents.sessions.context.filterAll')} value={ctl.roleFilter} onChange={ctl.setRoleFilter} options={roleOptions} />
              <div className="ses-filter-search">
                <SearchInput value={ctl.searchQuery} onChange={ctl.setSearchQuery} placeholder={t('agents.sessions.context.searchPlaceholder')} />
              </div>
            </div>

            <div className="ses-msg-list">
              {ctl.filteredMessages.length === 0 && ctl.newMessages.length === 0 && !ctl.hasMoreMessages ? (
                <p className="ses-empty-line ec-muted">{t('agents.sessions.context.emptyMessages')}</p>
              ) : null}
              {ctl.filteredMessages.map((message) => (
                <MessageBlock
                  key={message.id}
                  message={message}
                  edit={ctl.messageEdits[message.lineNumber] ?? { content: message.content, isEditing: false, isDeleted: false }}
                  saving={saving}
                  onEdit={(patch) => ctl.updateEdit(message.lineNumber, patch)}
                  onToggleDeleted={() => ctl.toggleDeleted(message.lineNumber)}
                />
              ))}
              {ctl.hasMoreMessages ? (
                <div className="ses-load-more">
                  {ctl.roleFilter !== 'all' || ctl.searchQuery.trim() ? (
                    <p className="ses-empty-line ec-muted">
                      {t('agents.sessions.context.partialHint', { loaded: formatNumber(ctl.loadedMessages), total: formatNumber(ctl.totalMessages) })}
                    </p>
                  ) : null}
                  <Button variant="outline" loading={ctl.loadingMore} disabled={saving} onClick={() => void ctl.loadMore()}>
                    {t('agents.sessions.context.loadMore', { loaded: formatNumber(ctl.loadedMessages), total: formatNumber(ctl.totalMessages) })}
                  </Button>
                </div>
              ) : null}
              {ctl.newMessages.map((message, index) => (
                <article key={`new-${index}`} className={`ses-msg ses-msg--${message.role} ses-msg--new`}>
                  <header className="ses-msg-head">
                    <span className="ses-role"><RoleIcon role={message.role} />{roleLabel(message.role)}</span>
                    <Badge tone="accent">{t('agents.sessions.context.newMessageBadge')}</Badge>
                    <span className="ses-msg-actions">
                      <IconButton size="sm" label={t('common.delete')} icon={<Trash2 size={13} />} disabled={saving}
                        onClick={() => ctl.setNewMessages((prev) => prev.filter((_, i) => i !== index))} />
                    </span>
                  </header>
                  <div className="ses-msg-body"><pre className="ses-msg-text">{message.content}</pre></div>
                </article>
              ))}

              {ctl.addingMessage ? (
                <div className="ses-add">
                  <div className="ses-add-head">
                    <strong>{t('agents.sessions.context.addMessage')}</strong>
                    <FilterChips
                      ariaLabel={t('agents.sessions.context.addMessageRole')}
                      value={ctl.newRole}
                      onChange={(role) => ctl.setNewRole(role)}
                      options={[
                        { value: 'user', label: t('agents.sessions.context.userRole'), icon: <RoleIcon role="user" size={12} /> },
                        { value: 'assistant', label: t('agents.sessions.context.assistantRole'), icon: <RoleIcon role="assistant" size={12} /> },
                      ]}
                    />
                  </div>
                  <textarea className="ses-textarea" aria-label={t('agents.sessions.context.addMessageContent')}
                    placeholder={t('agents.sessions.context.addMessageContent')} disabled={saving} rows={4}
                    value={ctl.newContent} onChange={(event) => ctl.setNewContent(event.target.value)} />
                  <div className="ses-add-actions">
                    <Button size="sm" variant="secondary" disabled={saving} onClick={ctl.cancelNewMessage}>{t('common.cancel')}</Button>
                    <Button size="sm" variant="primary" icon={<Plus size={13} />} disabled={saving || !ctl.newContent.trim()} onClick={ctl.commitNewMessage}>
                      {t('agents.sessions.context.addMessage')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" icon={<Plus size={14} />} disabled={saving || !detail.rolloutPath}
                  title={!detail.rolloutPath ? t('sec.agents.sessions.rolloutMissing') : undefined}
                  onClick={() => ctl.setAddingMessage(true)}>
                  {t('agents.sessions.context.addMessage')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </SidePanel>
  );
}
