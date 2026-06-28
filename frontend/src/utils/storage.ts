// Central registry of every sozvon-hub.* localStorage key the frontend uses.
// All reads and writes go through the typed helpers below.

import type { EngineKind } from '../types';
import { ENGINE_IDS } from '../audio/engine';

export const KEYS = {
  // Audio / engine
  outputVolume: 'sozvon-hub.output-volume',
  sendVolume: 'sozvon-hub.send-volume',
  engine: 'sozvon-hub.engine',
  micDeviceId: 'sozvon-hub.mic-device-id',
  camDeviceId: 'sozvon-hub.cam-device-id',
  // Persistent mute/deafen state — Discord-style, survives reloads.
  selfMuted: 'sozvon-hub.self-muted',
  deafened: 'sozvon-hub.deafened',
  preDeafenSelfMuted: 'sozvon-hub.pre-deafen-self-muted',
  // Identity: display name typed at the join prompt + stable per-install id.
  displayName: 'sozvon-hub.display-name',
  clientId: 'sozvon-hub.client-id',
  // Screen share capture preferences
  screenResolution: 'sozvon-hub.screen-resolution',
  screenFps: 'sozvon-hub.screen-fps',
  screenCodec: 'sozvon-hub.screen-codec',
  screenMode: 'sozvon-hub.screen-mode',
  screenShareMode: 'sozvon-hub.screen-share-mode',
} as const;

const PEER_VOLUME_PREFIX = 'sozvon-hub.peer-volume.';
const SCREEN_AUDIO_VOLUME_PREFIX = 'sozvon-hub.screen-audio-volume.';

// ---------------------------------------------------------------------------
// Primitive loaders
// ---------------------------------------------------------------------------

export function loadNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadBoolean(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === 'true';
}

export function saveBoolean(key: string, v: boolean): void {
  localStorage.setItem(key, String(v));
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function loadDisplayName(): string {
  return localStorage.getItem(KEYS.displayName) ?? '';
}

export function saveDisplayName(name: string): void {
  localStorage.setItem(KEYS.displayName, name.trim());
}

// Adjectives and animals are both masculine so "{adj} {animal}" always agrees in
// gender — keeps the generated name grammatical without per-word logic.
const GUEST_ADJECTIVES = [
  'Храбрый', 'Весёлый', 'Хитрый', 'Быстрый', 'Добрый', 'Смелый', 'Лохматый',
  'Сонный', 'Бодрый', 'Рыжий', 'Тихий', 'Шумный', 'Мудрый', 'Ловкий', 'Грозный',
  'Пушистый', 'Дерзкий', 'Важный', 'Озорной', 'Лунный',
];
const GUEST_ANIMALS = [
  'Барсук', 'Тигр', 'Волк', 'Ёж', 'Лис', 'Кит', 'Сокол', 'Бобр', 'Енот', 'Морж',
  'Жираф', 'Дельфин', 'Пингвин', 'Краб', 'Шмель', 'Филин', 'Барс', 'Як', 'Лось', 'Крот',
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// A friendly, readable guest name like "Хитрый Барсук" for users who join
// without typing a name.
export function makeGuestName(): string {
  return `${pick(GUEST_ADJECTIVES)} ${pick(GUEST_ANIMALS)}`;
}

// Stable client identifier, generated once on first launch and persisted.
// Sent in every `hello` so peers can key per-peer UI prefs by something that
// survives reconnects (peer IDs are ephemeral per WS).
export function loadOrCreateClientId(): string {
  const existing = localStorage.getItem(KEYS.clientId);
  if (existing && existing.length > 0) return existing;
  const fresh = crypto.randomUUID();
  localStorage.setItem(KEYS.clientId, fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// Per-peer prefs
// ---------------------------------------------------------------------------

export function loadPeerVolume(clientId: string): number | null {
  if (!clientId) return null;
  const raw = localStorage.getItem(PEER_VOLUME_PREFIX + clientId);
  if (raw === null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function savePeerVolume(clientId: string, volume: number): void {
  if (!clientId) return;
  localStorage.setItem(PEER_VOLUME_PREFIX + clientId, String(volume));
}

export function loadScreenAudioVolume(clientId: string): number | null {
  if (!clientId) return null;
  const raw = localStorage.getItem(SCREEN_AUDIO_VOLUME_PREFIX + clientId);
  if (raw === null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function saveScreenAudioVolume(clientId: string, volume: number): void {
  if (!clientId) return;
  localStorage.setItem(SCREEN_AUDIO_VOLUME_PREFIX + clientId, String(volume));
}

// ---------------------------------------------------------------------------
// Audio / engine / devices
// ---------------------------------------------------------------------------

export function saveSendVolume(v: number): void {
  localStorage.setItem(KEYS.sendVolume, String(v));
}

export function saveOutputVolume(v: number): void {
  localStorage.setItem(KEYS.outputVolume, String(v));
}

const ENGINE_VALUES: EngineKind[] = ['off', ...ENGINE_IDS];

export function loadEngine(): EngineKind {
  const raw = localStorage.getItem(KEYS.engine);
  return ENGINE_VALUES.includes(raw as EngineKind) ? (raw as EngineKind) : 'browser';
}

export function saveEngine(e: EngineKind): void {
  localStorage.setItem(KEYS.engine, e);
}

export function loadMicDeviceId(): string | null {
  const raw = localStorage.getItem(KEYS.micDeviceId);
  return raw && raw.length > 0 ? raw : null;
}

export function saveMicDeviceId(id: string | null): void {
  if (id) localStorage.setItem(KEYS.micDeviceId, id);
  else localStorage.removeItem(KEYS.micDeviceId);
}

export function loadCamDeviceId(): string | null {
  const raw = localStorage.getItem(KEYS.camDeviceId);
  return raw && raw.length > 0 ? raw : null;
}

export function saveCamDeviceId(id: string | null): void {
  if (id) localStorage.setItem(KEYS.camDeviceId, id);
  else localStorage.removeItem(KEYS.camDeviceId);
}
