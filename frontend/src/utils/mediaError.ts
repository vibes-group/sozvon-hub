// Reads the DOMException-style `name` off an unknown thrown value. getUserMedia
// rejections (OverconstrainedError, NotAllowedError, NotFoundError) aren't all
// Error subclasses across browsers, so `instanceof Error`/`instanceof
// DOMException` is unreliable — match the `name` field directly.
export function errorName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err
    ? String((err as { name?: unknown }).name)
    : '';
}
