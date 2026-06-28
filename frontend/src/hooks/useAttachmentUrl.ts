import { useEffect, useRef, useState, useCallback } from 'react';
import type { Attachment } from '../sfu/protocol';
import { getBlob, putBlob } from '../utils/blobCache';

// Resolves an attachment's bytes: in-memory cache first, then the transient
// download endpoint. A 404 means the server already evicted the upload (the
// room ended) and returns null; any other non-OK status throws so the caller
// can retry. Successful downloads are cached so re-renders hit locally.
async function resolveAttachmentBlob(
  uploadId: string,
  roomId: string,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const cached = getBlob(uploadId);
  if (cached) return cached;
  const res = await fetch(
    `/api/file/${encodeURIComponent(uploadId)}?room=${encodeURIComponent(roomId)}`,
    { credentials: 'same-origin', signal },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const blob = await res.blob();
  putBlob(uploadId, blob);
  return blob;
}

// Triggers a browser download of the attachment via a synthetic anchor.
export async function downloadAttachment(att: Attachment, roomId: string): Promise<void> {
  const blob = await resolveAttachmentBlob(att.uploadId, roomId);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = att.name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type AttachmentUrlStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export type AttachmentUrlState = {
  url: string | null;
  status: AttachmentUrlStatus;
  reload: () => void;
};

// Resolves an attachment to an object URL for rendering, owning the URL's
// lifecycle (revoked on unmount or when the source changes) so callers never
// leak. 'unavailable' is the terminal 404 state; 'error' is retryable. Pass
// enabled=false to skip resolution entirely.
export function useAttachmentUrl(
  uploadId: string,
  roomId: string,
  enabled = true,
): AttachmentUrlState {
  const [status, setStatus] = useState<AttachmentUrlStatus>('loading');
  const [url, setUrl] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const urlRef = useRef<string | null>(null);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const controller = new AbortController();
    setStatus('loading');
    setUrl(null);

    resolveAttachmentBlob(uploadId, roomId, controller.signal)
      .then((blob) => {
        if (cancelled) return;
        if (!blob) {
          setStatus('unavailable');
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        urlRef.current = objectUrl;
        setUrl(objectUrl);
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled || (err as DOMException)?.name === 'AbortError') return;
        setStatus('error');
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [uploadId, roomId, attempt, enabled]);

  return { url, status, reload };
}
