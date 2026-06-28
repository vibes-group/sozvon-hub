import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, Trash2 } from 'lucide-react';
import { selectSelfPeerId, useStore, type ChatMessage } from '../store/useStore';
import { CHAT_MAX_BYTES } from '../sfu/protocol';
import { loadOrCreateClientId } from '../utils/storage';

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TEXT_ENCODER = new TextEncoder();

function byteLength(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function renderText(text: string) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    if (!raw) continue;
    if (start > last) parts.push(text.slice(last, start));
    const href = raw.startsWith('www.') ? `https://${raw}` : raw;
    parts.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-accent underline underline-offset-2 break-all hover:opacity-80"
      >
        {raw}
      </a>,
    );
    last = start + raw.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

type Props = {
  onSend: (text: string, clientMsgId: string) => void;
  onDelete: (id: string) => boolean;
};

export function ChatPanel({ onSend, onDelete }: Props) {
  const messages = useStore((s) => s.chat);
  const participants = useStore((s) => s.participants);
  const chatSendOptimistic = useStore((s) => s.chatSendOptimistic);
  const selfPeerId = useStore(selectSelfPeerId);
  const selfClientId = useRef(loadOrCreateClientId()).current;

  const [text, setText] = useState('');
  const bytes = byteLength(text);
  const overLimit = bytes > CHAT_MAX_BYTES;
  const canSend = text.trim().length > 0 && !overLimit && !!selfPeerId;

  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const prevLenRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length !== prevLenRef.current) {
      prevLenRef.current = messages.length;
      if (atBottomRef.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [messages.length]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || overLimit || !selfPeerId) return;
    const clientMsgId = crypto.randomUUID();
    const selfEntry = participants[selfPeerId];
    chatSendOptimistic({
      id: clientMsgId,
      from: selfPeerId,
      text: trimmed,
      ts: Date.now(),
      clientMsgId,
      pending: true,
      senderName: selfEntry?.display,
      senderClientId: selfEntry?.clientId,
    });
    onSend(trimmed, clientMsgId);
    setText('');
  }, [text, overLimit, selfPeerId, participants, chatSendOptimistic, onSend]);

  const visible = useMemo(() => {
    return messages.map((msg, i) => {
      const prev = i > 0 ? messages[i - 1] : null;
      const sameSender =
        prev !== null &&
        (prev.senderClientId !== undefined && msg.senderClientId !== undefined
          ? prev.senderClientId === msg.senderClientId
          : prev.from === msg.from);
      const showName = !(sameSender && prev !== null && msg.ts - prev.ts < 5 * 60_000);
      const isSelf =
        msg.senderClientId !== undefined
          ? msg.senderClientId === selfClientId
          : msg.from === selfPeerId;
      const senderName =
        msg.senderName ?? participants[msg.from]?.display ?? (isSelf ? 'Вы' : 'Неизвестный');
      return { msg, isSelf, senderName, showName };
    });
  }, [messages, participants, selfClientId, selfPeerId]);

  return (
    <section className="card p-0! flex flex-col flex-1 min-h-0">
      <div className="px-5 pt-4 pb-3 border-b border-line shrink-0">
        <h2 className="card-title">Чат</h2>
      </div>

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 grid content-start gap-0.5"
      >
        {visible.length === 0 && (
          <div className="px-2 py-8 text-center text-muted-2 text-[12px] uppercase tracking-[0.12em]">
            Сообщений пока нет
          </div>
        )}
        {visible.map((row) => (
          <ChatRow key={row.msg.id} row={row} onDelete={onDelete} />
        ))}
      </div>

      <div className="px-3 pb-3 pt-3 border-t border-line shrink-0">
        <div
          className={`flex gap-1.5 items-end p-1.5 border ${overLimit ? 'border-danger' : 'border-line'} bg-bg-input focus-within:border-accent transition-[border-color]`}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={selfPeerId ? 'Сообщение…' : 'Подключитесь, чтобы писать'}
            rows={1}
            disabled={!selfPeerId}
            className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] text-text placeholder:text-muted-2 focus:outline-none disabled:opacity-40"
            style={{ minHeight: 36, maxHeight: 120 }}
          />
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="btn btn-primary shrink-0 grid place-items-center p-0!"
            style={{ width: 38, height: 38 }}
            aria-label="Отправить"
          >
            <Send size={20} />
          </button>
        </div>
        {bytes > CHAT_MAX_BYTES * 0.8 && (
          <div
            className={`mt-1 text-right text-[11px] tabular-nums ${overLimit ? 'text-danger' : 'text-muted-2'}`}
          >
            {bytes}/{CHAT_MAX_BYTES}
          </div>
        )}
      </div>
    </section>
  );
}

function ChatRow({
  row,
  onDelete,
}: {
  row: { msg: ChatMessage; isSelf: boolean; senderName: string; showName: boolean };
  onDelete: (id: string) => boolean;
}) {
  const { msg, isSelf, senderName, showName } = row;
  const canDelete = isSelf && !msg.pending;
  return (
    <div className={`group px-2 ${showName ? 'pt-2' : ''} ${msg.pending ? 'opacity-50' : ''}`}>
      {showName && (
        <div className="flex items-baseline gap-2 mb-0.5">
          <span
            className={`text-[11px] font-bold uppercase tracking-[0.14em] truncate ${isSelf ? 'text-accent' : 'text-muted'}`}
          >
            {senderName}
          </span>
          <span className="text-[11px] text-muted-2 tabular-nums">{formatTime(msg.ts)}</span>
        </div>
      )}
      <div className="flex items-baseline gap-2">
        <p className="m-0 flex-1 text-[15px] text-body break-words whitespace-pre-wrap">
          {renderText(msg.text)}
        </p>
        {canDelete && (
          <button
            onClick={() => onDelete(msg.id)}
            aria-label="Удалить"
            className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-2 hover:text-danger transition"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
