import {
  memo,
  useRef,
  useMemo,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
  type DragEvent,
  type ClipboardEvent,
} from 'react';
import { Send, Info, Paperclip, X, Trash2, WifiOff } from 'lucide-react';
import { selectSelfPeerId, useStore, type ChatMessage } from '../store/useStore';
import {
  CHAT_MAX_BYTES,
  CHAT_MAX_ATTACHMENTS,
  type Attachment,
  type AttachmentKind,
} from '../sfu/protocol';
import { loadOrCreateClientId } from '../utils/storage';
import { uploadFile, imageMeta, MAX_UPLOAD_BYTES, TEMP_UPLOAD_PREFIX } from '../utils/uploadFile';
import { putBlob, getBlob, rekeyBlob } from '../utils/blobCache';
import { AttachmentImage } from './AttachmentImage';
import { AttachmentAlbum } from './AttachmentAlbum';
import { AttachmentFileCard, formatFileSize } from './AttachmentFileCard';
import { ImageLightbox } from './ImageLightbox';

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TEXT_ENCODER = new TextEncoder();

const CHAT_HINT =
  'Сообщения и файлы видны всем в комнате.\nСервер их не хранит — только пересылает.\nФайлы удаляются вместе с комнатой.';

function trimUrl(raw: string): string {
  let s = raw.replace(/[.,;:!?]+$/, '');
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  while (s.length > 0) {
    const last = s[s.length - 1];
    const open = pairs[last];
    if (!open) break;
    let opens = 0;
    let closes = 0;
    for (const ch of s) {
      if (ch === open) opens++;
      else if (ch === last) closes++;
    }
    if (closes <= opens) break;
    s = s.slice(0, -1);
  }
  return s;
}

function renderText(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = trimUrl(m[0]);
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

function byteLength(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

type Props = {
  roomId: string;
  onSend: (text: string, clientMsgId: string, attachments?: Attachment[]) => void;
  // Returns false when the request couldn't be sent (socket closed); deletion
  // only takes effect on the server's echo, so we surface that.
  onDelete: (id: string) => boolean;
};

type VisibleMessage = {
  msg: ChatMessage;
  isSelf: boolean;
  senderName: string;
  showName: boolean;
  renderedText: ReactNode;
};

export function ChatPanel({ roomId, onSend, onDelete }: Props) {
  const messages = useStore((s) => s.chat);
  const participants = useStore((s) => s.participants);
  const chatSendOptimistic = useStore((s) => s.chatSendOptimistic);
  const chatUpdateUploadProgress = useStore((s) => s.chatUpdateUploadProgress);
  const chatMarkUploadFailed = useStore((s) => s.chatMarkUploadFailed);
  const chatSetAttachments = useStore((s) => s.chatSetAttachments);

  const selfPeerId = useStore(selectSelfPeerId);
  // Stable per-install identity — lets MessageRow recognise own messages.
  const selfClientId = useRef(loadOrCreateClientId()).current;

  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const bytes = byteLength(text);
  const overLimit = bytes > CHAT_MAX_BYTES;
  const canSend = (text.trim().length > 0 || files.length > 0) && !overLimit && !!selfPeerId;

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

  const addFiles = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    const tooBig = incoming.some((f) => f.size > MAX_UPLOAD_BYTES);
    const ok = incoming.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    setFileError(
      tooBig ? `Файл больше ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} МБ — не добавлен` : null,
    );
    setFiles((prev) => [...prev, ...ok].slice(0, CHAT_MAX_ATTACHMENTS));
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Uploads each temp-keyed attachment (skipping ones already on a real id),
  // rekeys its cached blob to the server id, then sends the chat message.
  // blobFor supplies each attachment's bytes — the original File on first send,
  // the cached temp blob on retry.
  const uploadAttachmentsAndSend = useCallback(
    async (
      clientMsgId: string,
      msgText: string,
      attachments: Attachment[],
      blobFor: (att: Attachment, index: number) => Blob | null,
    ) => {
      try {
        const progress = new Array(attachments.length).fill(0);
        const real = await Promise.all(
          attachments.map(async (att, i) => {
            if (!att.uploadId.startsWith(TEMP_UPLOAD_PREFIX)) {
              progress[i] = 1;
              return att;
            }
            const blob = blobFor(att, i);
            if (!blob) throw new Error('attachment blob missing');
            const uploadId = await uploadFile(blob, roomId, {
              name: att.name,
              onProgress: (fraction) => {
                progress[i] = fraction;
                const agg = progress.reduce((a, b) => a + b, 0) / attachments.length;
                chatUpdateUploadProgress(clientMsgId, agg);
              },
            });
            rekeyBlob(att.uploadId, uploadId);
            return { ...att, uploadId };
          }),
        );
        chatSetAttachments(clientMsgId, real);
        chatUpdateUploadProgress(clientMsgId, 1);
        onSend(msgText, clientMsgId, real);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        chatMarkUploadFailed(clientMsgId);
      }
    },
    [roomId, onSend, chatUpdateUploadProgress, chatSetAttachments, chatMarkUploadFailed],
  );

  const sendMessage = useCallback(
    async (trimmed: string, outgoing: File[]) => {
      if (!selfPeerId) return;
      const clientMsgId = crypto.randomUUID();
      const selfEntry = participants[selfPeerId];

      const tempAttachments: Attachment[] = await Promise.all(
        outgoing.map(async (file, i) => {
          const uploadId = `${TEMP_UPLOAD_PREFIX}${clientMsgId}:${i}`;
          putBlob(uploadId, file);
          const kind: AttachmentKind = file.type.startsWith('image/') ? 'image' : 'file';
          if (kind === 'image') {
            const meta = await imageMeta(file);
            return {
              uploadId,
              kind,
              name: file.name,
              mime: file.type,
              size: file.size,
              width: meta?.width,
              height: meta?.height,
              blurThumb: meta?.blurThumb,
            };
          }
          return { uploadId, kind, name: file.name, mime: file.type, size: file.size };
        }),
      );

      chatSendOptimistic({
        id: clientMsgId,
        from: selfPeerId,
        text: trimmed,
        ts: Date.now(),
        clientMsgId,
        pending: true,
        senderName: selfEntry?.display,
        senderClientId: selfEntry?.clientId,
        attachments: tempAttachments.length ? tempAttachments : undefined,
        uploadProgress: outgoing.length ? 0 : undefined,
      });

      if (outgoing.length === 0) {
        onSend(trimmed, clientMsgId);
        return;
      }
      await uploadAttachmentsAndSend(clientMsgId, trimmed, tempAttachments, (_att, i) => outgoing[i]);
    },
    [selfPeerId, participants, chatSendOptimistic, onSend, uploadAttachmentsAndSend],
  );

  const retryMessage = useCallback(
    async (msg: ChatMessage) => {
      if (!msg.clientMsgId) return;
      chatUpdateUploadProgress(msg.clientMsgId, 0);
      await uploadAttachmentsAndSend(msg.clientMsgId, msg.text, msg.attachments ?? [], (att) =>
        getBlob(att.uploadId),
      );
    },
    [chatUpdateUploadProgress, uploadAttachmentsAndSend],
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || overLimit || !selfPeerId) return;
    setText('');
    setFiles([]);
    setFileError(null);
    void sendMessage(trimmed, files);
  }, [text, files, overLimit, selfPeerId, sendMessage]);

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const pasted = Array.from(e.clipboardData.items)
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (pasted.length) {
        e.preventDefault();
        addFiles(pasted);
      }
    },
    [addFiles],
  );

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth.current++;
    setDragging(true);
  }, []);
  const onDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);
  const onDragOver = useCallback((e: DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles],
  );

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const visible = useMemo<VisibleMessage[]>(() => {
    // Order by the server-assigned ULID `id` — it's lexicographically sortable
    // by server-receive time, so every client shows the same order regardless of
    // WS arrival jitter. Pending optimistic messages have no server id yet (their
    // id is a client UUID), so keep them at the bottom as the just-sent tail.
    const ordered = [...messages].sort((a, b) => {
      if (Boolean(a.pending) !== Boolean(b.pending)) return a.pending ? 1 : -1;
      if (a.pending) return 0; // both pending → stable sort keeps send order
      return a.id.localeCompare(b.id);
    });
    return ordered.map((msg, i) => {
      const prev = i > 0 ? ordered[i - 1] : null;
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
      return { msg, isSelf, senderName, showName, renderedText: renderText(msg.text) };
    });
  }, [messages, participants, selfClientId, selfPeerId]);

  // Flat list of every image in the visible chat, so the lightbox pages across
  // all of them with ←/→ regardless of which message they belong to.
  const imageList = useMemo<Attachment[]>(
    () => visible.flatMap((v) => (v.msg.attachments ?? []).filter((a) => a.kind === 'image')),
    [visible],
  );
  const imageListRef = useRef(imageList);
  imageListRef.current = imageList;

  const openLightbox = useCallback((att: Attachment) => {
    const idx = imageListRef.current.findIndex((a) => a.uploadId === att.uploadId);
    if (idx >= 0) setLightboxIndex(idx);
  }, []);
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
  }, []);
  const handleDelete = useCallback(
    (id: string) => {
      if (onDelete(id)) return;
      setNotice('Нет соединения — сообщение не удалено');
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = setTimeout(() => setNotice(null), 3500);
    },
    [onDelete],
  );

  return (
    <section
      className="card relative p-0! flex flex-col flex-1 min-h-0"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="px-5 pt-4 pb-3 border-b border-line shrink-0">
        <h2 className="card-title flex items-center gap-1.5">
          Чат
          <span
            tabIndex={0}
            className="group relative inline-flex outline-none cursor-help text-muted-2/60 hover:text-muted-2 focus-visible:text-muted-2 transition-colors"
          >
            <Info size={15} strokeWidth={2} aria-label="Как работает чат" />
            <span
              role="tooltip"
              className="pointer-events-none invisible absolute left-0 top-full z-20 mt-2 w-max whitespace-pre border border-line-strong bg-bg-3 px-3 py-2 text-[12px] leading-snug text-muted normal-case tracking-normal font-normal opacity-0 shadow-lg transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
            >
              {CHAT_HINT}
            </span>
          </span>
        </h2>
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
          <MessageRow
            key={row.msg.id}
            row={row}
            roomId={roomId}
            onImageClick={openLightbox}
            onRetry={retryMessage}
            onDelete={handleDelete}
          />
        ))}
      </div>

      <div className="px-3 pb-3 pt-3 border-t border-line shrink-0">
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {files.map((file, i) => (
              <TrayItem key={`${file.name}-${i}`} file={file} onRemove={() => removeFile(i)} />
            ))}
          </div>
        )}
        <div
          className={`flex gap-1.5 items-end p-1.5 border ${overLimit ? 'border-danger' : 'border-line'} bg-bg-input focus-within:border-accent transition-[border-color]`}
        >
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!selfPeerId || files.length >= CHAT_MAX_ATTACHMENTS}
            className="btn btn-secondary shrink-0 grid place-items-center p-0! border-0 disabled:opacity-40"
            style={{ width: 38, height: 38 }}
            aria-label="Прикрепить файл"
            title="Прикрепить файл"
          >
            <Paperclip size={20} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
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
            onPaste={handlePaste}
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
        {fileError && <div className="mt-1 text-[11px] text-danger">{fileError}</div>}
        {bytes > CHAT_MAX_BYTES * 0.8 && (
          <div
            className={`mt-1 text-right text-[11px] tabular-nums ${overLimit ? 'text-danger' : 'text-muted-2'}`}
          >
            {bytes}/{CHAT_MAX_BYTES}
          </div>
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center border-2 border-dashed border-accent bg-bg-0/80 text-accent text-[14px] uppercase tracking-[0.14em]">
          Отпустите файлы, чтобы прикрепить
        </div>
      )}

      <ImageLightbox
        images={imageList}
        index={lightboxIndex}
        roomId={roomId}
        onClose={closeLightbox}
        onNavigate={setLightboxIndex}
      />

      {notice && (
        <div
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5 bg-bg-1 border border-danger text-danger text-[13px] shadow-lg pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <WifiOff size={16} aria-hidden />
          <span>{notice}</span>
        </div>
      )}
    </section>
  );
}

const TrayItem = memo(function TrayItem({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith('image/');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className="relative h-16 w-16 shrink-0 overflow-hidden border border-line bg-bg-2">
      {isImage && previewUrl ? (
        <img src={previewUrl} alt={file.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center px-1 text-center">
          <span className="truncate text-[10px] text-body w-full">{file.name}</span>
          <span className="text-[9px] text-muted-2">{formatFileSize(file.size)}</span>
        </div>
      )}
      <button
        onClick={onRemove}
        aria-label="Убрать"
        className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center bg-black/70 text-white hover:bg-black"
      >
        <X size={12} />
      </button>
    </div>
  );
});

const MessageRow = memo(function MessageRow({
  row,
  roomId,
  onImageClick,
  onRetry,
  onDelete,
}: {
  row: VisibleMessage;
  roomId: string;
  onImageClick: (att: Attachment) => void;
  onRetry: (msg: ChatMessage) => void;
  onDelete: (id: string) => void;
}) {
  const { msg, isSelf, senderName, showName, renderedText } = row;
  const attachments = msg.attachments ?? [];
  const images = attachments.filter((a) => a.kind === 'image');
  const fileCards = attachments.filter((a) => a.kind === 'file');
  const uploading =
    msg.pending && !msg.uploadFailed && msg.uploadProgress !== undefined && msg.uploadProgress < 1;
  // Only confirmed own messages (server id assigned) can be retracted.
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

      {attachments.length > 0 && (
        <div className="mb-1 flex flex-col gap-1.5">
          {images.length === 1 && (
            <AttachmentImage
              attachment={images[0]}
              roomId={roomId}
              onClick={() => onImageClick(images[0])}
            />
          )}
          {images.length > 1 && (
            <AttachmentAlbum images={images} roomId={roomId} onOpen={onImageClick} />
          )}
          {fileCards.map((att) => (
            <AttachmentFileCard key={att.uploadId} attachment={att} roomId={roomId} />
          ))}
        </div>
      )}

      <div className="flex items-baseline gap-2">
        {msg.text && (
          <p className="m-0 flex-1 text-[15px] text-body break-words whitespace-pre-wrap">
            {renderedText}
          </p>
        )}
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

      {uploading && (
        <div className="mt-1 h-1 overflow-hidden bg-bg-3">
          <div
            className="h-full bg-accent transition-[width] duration-150"
            style={{ width: `${Math.round((msg.uploadProgress ?? 0) * 100)}%` }}
          />
        </div>
      )}
      {msg.uploadFailed && (
        <div className="mt-1 flex items-center gap-2 text-[12px] text-danger">
          <span>Не удалось загрузить</span>
          <button onClick={() => onRetry(msg)} className="underline hover:opacity-80">
            Повторить
          </button>
        </div>
      )}
    </div>
  );
});
