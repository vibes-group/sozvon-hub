import { useEffect, useState } from 'react';

// Touch-primary device (phone/tablet): the pointer can't hover. Desktop: a
// fine pointer that can hover. They are not strict complements — hybrids may be
// neither — and both default to false when matchMedia is unavailable (SSR/tests).
export const IS_TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches;
export const IS_DESKTOP =
  typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;

// Enumerate real media input devices of one kind, dropping the synthetic
// "default"/"communications" aliases (and any empty id) the browser adds, so
// each physical device shows exactly once. Resolves to [] when mediaDevices is
// unavailable. Matches voice-hub.
export function listInputDevices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  return (navigator.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([])).then((all) =>
    all.filter(
      (d) =>
        d.kind === kind &&
        d.deviceId &&
        d.deviceId !== 'default' &&
        d.deviceId !== 'communications',
    ),
  );
}

// Reactive list of real input devices of one kind. Re-enumerates on
// `devicechange` and whenever `dep` changes — device ids/labels only populate
// after permission is granted, so callers pass e.g. `cameraOn` to re-read then.
export function useInputDevices(kind: MediaDeviceKind, dep?: unknown): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      listInputDevices(kind)
        .then((real) => {
          if (!cancelled) setDevices(real);
        })
        .catch(() => {});
    };
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
    };
  }, [kind, dep]);
  return devices;
}
