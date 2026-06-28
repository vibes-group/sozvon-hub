// In-memory cache of attachment bytes, keyed by uploadId. Lets the sender show
// a local preview before upload finishes (keyed by a temp id, rekeyed to the
// server id once known) and avoids re-downloading a file we just uploaded.
//
// Deliberately NOT persisted: rooms are ephemeral and the server deletes the
// files when the room ends, so a reload simply re-fetches from the server.

const cache = new Map<string, Blob>();

export function putBlob(id: string, blob: Blob): void {
  cache.set(id, blob);
}

export function getBlob(id: string): Blob | null {
  return cache.get(id) ?? null;
}

export function rekeyBlob(from: string, to: string): void {
  const blob = cache.get(from);
  if (!blob) return;
  cache.set(to, blob);
  cache.delete(from);
}

export function deleteBlob(id: string): void {
  cache.delete(id);
}
