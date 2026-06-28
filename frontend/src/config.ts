import type { AppConfig } from './types';

export async function loadAppConfig(): Promise<AppConfig> {
  const response = await fetch('/api/config', { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error('Не удалось получить конфигурацию');
  }
  const raw = (await response.json()) as { iceServers?: unknown };
  if (!Array.isArray(raw.iceServers)) {
    throw new Error('Конфигурация: iceServers отсутствует или не массив');
  }
  return { iceServers: raw.iceServers as RTCIceServer[] };
}

export function buildWsUrl(roomSlug: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/${encodeURIComponent(roomSlug)}`;
}
