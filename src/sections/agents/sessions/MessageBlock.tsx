import { Bot, Brain, Cpu, Pencil, ShieldAlert, Trash2, Undo2, User, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { usePrivacyMask } from '../../../privacy';
import type { CodexSessionMessageItem } from '../../../services/codexSessionState';
import { Chip, CopyButton, IconButton, RelativeTime, cx } from '../../../ui';
import type { MessageEditState } from './useSessionContext';

type RoleKey = 'user' | 'assistant' | 'reasoning' | 'tool';
const ROLE_LABEL: Record<RoleKey, 'agents.sessions.context.userRole' | 'agents.sessions.context.assistantRole'
  | 'agents.sessions.context.reasoningRole' | 'agents.sessions.context.toolRole'> = {
  user: 'agents.sessions.context.userRole',
  assistant: 'agents.sessions.context.assistantRole',
  reasoning: 'agents.sessions.context.reasoningRole',
  tool: 'agents.sessions.context.toolRole',
};

export function RoleIcon({ role, size = 13 }: { role: string; size?: number }) {
  if (role === 'user') return <User size={size} aria-hidden />;
  if (role === 'assistant') return <Bot size={size} aria-hidden />;
  if (role === 'reasoning') return <Brain size={size} aria-hidden />;
  if (role === 'tool') return <Wrench size={size} aria-hidden />;
  return <Cpu size={size} aria-hidden />;
}

/** Role chip text: localized for the four editable-context roles, the raw role name for system/turn_context rows. */
export function useRoleLabel() {
  const { t } = useI18n();
  return (role: string) => (role in ROLE_LABEL ? t(ROLE_LABEL[role as RoleKey]) : role);
}

type MessageBlockProps = {
  message: CodexSessionMessageItem;
  edit: MessageEditState;
  saving: boolean;
  onEdit: (patch: Partial<MessageEditState>) => void;
  onToggleDeleted: () => void;
};

/**
 * One role-tagged message of the session rollout. Tool rows can only be removed (call + result together); user,
 * assistant and reasoning rows can be edited in place. Display text goes through the privacy mask; the textarea and the
 * copy button always carry the raw text.
 */
export function MessageBlock({ message, edit, saving, onEdit, onToggleDeleted }: MessageBlockProps) {
  const { t } = useI18n();
  const mask = usePrivacyMask();
  const roleLabel = useRoleLabel();
  const modified = edit.content !== message.content;
  const editable = message.role !== 'tool';
  let body: ReactNode;
  if (edit.isDeleted) {
    body = <p className="ses-msg-note">{t('agents.sessions.context.pendingDeletion')}</p>;
  } else if (edit.isEditing && editable) {
    body = (
      <div className="ses-msg-edit">
        {message.role === 'reasoning' ? (
          <p className="ses-msg-warn"><ShieldAlert size={13} aria-hidden />{t('agents.sessions.context.reasoningEditNotice')}</p>
        ) : null}
        <textarea
          className="ses-textarea"
          aria-label={t('agents.sessions.context.addMessageContent')}
          disabled={saving}
          value={edit.content}
          rows={Math.min(15, Math.max(3, edit.content.split('\n').length))}
          onChange={(event) => onEdit({ content: event.target.value })}
        />
        {modified ? (
          <button type="button" className="ses-link-btn" disabled={saving} onClick={() => onEdit({ content: message.content })}>
            {t('agents.sessions.context.restoreOriginal')}
          </button>
        ) : null}
      </div>
    );
  } else {
    body = <pre className="ses-msg-text">{mask.text(edit.content)}</pre>;
  }

  return (
    <article
      className={cx('ses-msg', `ses-msg--${message.role}`, edit.isDeleted && 'ses-msg--deleted', modified && 'ses-msg--modified')}
      data-role={message.role}
    >
      <header className="ses-msg-head">
        <span className="ses-role"><RoleIcon role={message.role} />{roleLabel(message.role)}</span>
        <span className="ses-line ec-mono ec-muted">#{message.lineNumber + 1}</span>
        {message.timestamp ? <span className="ec-muted ses-msg-time"><RelativeTime value={message.timestamp} /></span> : null}
        {message.model ? <span className="ses-msg-model ec-mono ec-muted ec-trunc">{message.model}</span> : null}
        {message.signatureStripped ? (
          <span title={t('agents.sessions.context.signatureStrippedNotice')}>
            <Chip size="sm" tone="warn" icon={<ShieldAlert size={11} />}>{t('agents.sessions.context.signatureStrippedBadge')}</Chip>
          </span>
        ) : null}
        {modified && !edit.isDeleted ? <Chip size="sm" tone="accent">{t('sec.agents.sessions.edited')}</Chip> : null}
        <span className="ses-msg-actions">
          <CopyButton value={edit.content} size="sm" />
          {editable ? (
            <IconButton size="sm" label={t('agents.sessions.context.editMessage')} icon={<Pencil size={13} />}
              active={edit.isEditing} disabled={saving || edit.isDeleted}
              onClick={() => onEdit({ isEditing: !edit.isEditing })} />
          ) : null}
          <IconButton size="sm"
            label={edit.isDeleted ? t('agents.sessions.context.restoreMessage') : t('agents.sessions.context.deleteMessage')}
            icon={edit.isDeleted ? <Undo2 size={13} /> : <Trash2 size={13} />}
            disabled={saving} onClick={onToggleDeleted} />
        </span>
      </header>
      <div className="ses-msg-body">{body}</div>
    </article>
  );
}
