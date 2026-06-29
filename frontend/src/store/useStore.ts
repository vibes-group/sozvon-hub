// Zustand store: reactive UI state.
// Audio nodes are NOT stored here — they live in imperative refs inside useAudioEngine.

import { create } from 'zustand';
import type { EngineKind, ParticipantUI } from '../types';
import type { Attachment } from '../sfu/protocol';
import {
  KEYS,
  loadBoolean,
  loadEngine,
  loadMicDeviceId,
  loadCamDeviceId,
  loadNumber,
  saveBoolean,
  saveSendVolume,
  saveOutputVolume,
  saveEngine,
  saveMicDeviceId,
  saveCamDeviceId,
} from '../utils/storage';

export type ChatMessage = {
  id: string;
  from: string;
  text: string;
  ts: number;
  clientMsgId?: string;
  pending?: boolean;
  senderName?: string;
  senderClientId?: string;
  attachments?: Attachment[];
  // Transient sender-only fields while attachments upload (never broadcast).
  uploadProgress?: number;
  uploadFailed?: boolean;
};

export type JoinState = 'idle' | 'joining' | 'joined';
type StatusState = 'idle' | 'ok' | 'err';

function compareParticipants(a: ParticipantUI, b: ParticipantUI): number {
  if (a.isSelf) return -1;
  if (b.isSelf) return 1;
  return (a.clientId ?? a.id).localeCompare(b.clientId ?? b.id);
}

let sortedCache: { source: Record<string, ParticipantUI>; list: ParticipantUI[] } | null = null;

function getSortedList(participants: Record<string, ParticipantUI>): ParticipantUI[] {
  if (sortedCache && sortedCache.source === participants) return sortedCache.list;
  const list = Object.values(participants).sort(compareParticipants);
  sortedCache = { source: participants, list };
  return list;
}

export const selectParticipants = (state: AppState): ParticipantUI[] =>
  getSortedList(state.participants);

export const selectSelfPeerId = (state: AppState): string | null => {
  for (const [id, participant] of Object.entries(state.participants)) {
    if (participant.isSelf) return id;
  }
  return null;
};

export interface AppState {
  joinState: JoinState;
  setJoinState: (s: JoinState) => void;

  // True once /api/config has resolved — gates Join until iceServers are known.
  configReady: boolean;
  setConfigReady: (v: boolean) => void;

  // Mute/deafen are persistent (Discord-style — survive reload).
  selfMuted: boolean;
  setSelfMuted: (v: boolean) => void;
  deafened: boolean;
  setDeafened: (v: boolean) => void;
  preDeafenSelfMuted: boolean;
  enterDeafen: () => void;

  cameraOn: boolean;
  setCameraOn: (v: boolean) => void;

  sendVolume: number;
  setSendVolume: (v: number) => void;
  outputVolume: number;
  setOutputVolume: (v: number) => void;

  engine: EngineKind;
  setEngine: (e: EngineKind) => void;

  micDeviceId: string | null;
  setMicDeviceId: (id: string | null) => void;
  camDeviceId: string | null;
  setCamDeviceId: (id: string | null) => void;

  statusText: string;
  statusState: StatusState;
  setStatus: (text: string, isError?: boolean, joined?: boolean) => void;

  participants: Record<string, ParticipantUI>;
  upsertParticipant: (p: Partial<ParticipantUI> & { id: string }) => ParticipantUI;
  removeParticipant: (id: string) => void;
  clearParticipants: () => void;
  updateParticipant: (id: string, patch: Partial<ParticipantUI>) => void;

  // Chat — in-memory only (rooms are ephemeral, server doesn't persist).
  chat: ChatMessage[];
  clearChat: () => void;
  chatSendOptimistic: (msg: ChatMessage) => void;
  chatReceive: (msg: ChatMessage) => void;
  chatDelete: (id: string) => void;
  chatUpdateUploadProgress: (clientMsgId: string, progress: number) => void;
  chatMarkUploadFailed: (clientMsgId: string) => void;
  chatSetAttachments: (clientMsgId: string, attachments: Attachment[]) => void;
}

export const useStore = create<AppState>((set) => ({
  joinState: 'idle',
  setJoinState: (s) => set({ joinState: s }),
  configReady: false,
  setConfigReady: (v) => set({ configReady: v }),

  selfMuted: loadBoolean(KEYS.selfMuted, false),
  setSelfMuted: (v) => {
    saveBoolean(KEYS.selfMuted, v);
    set({ selfMuted: v });
  },
  deafened: loadBoolean(KEYS.deafened, false),
  setDeafened: (v) => {
    saveBoolean(KEYS.deafened, v);
    set({ deafened: v });
  },
  preDeafenSelfMuted: loadBoolean(KEYS.preDeafenSelfMuted, false),
  enterDeafen: () =>
    set((s) => {
      saveBoolean(KEYS.selfMuted, true);
      saveBoolean(KEYS.deafened, true);
      saveBoolean(KEYS.preDeafenSelfMuted, s.selfMuted);
      return {
        preDeafenSelfMuted: s.selfMuted,
        deafened: true,
        selfMuted: true,
      };
    }),

  cameraOn: false,
  setCameraOn: (v) => set({ cameraOn: v }),

  sendVolume: loadNumber(KEYS.sendVolume, 100),
  setSendVolume: (v) => {
    saveSendVolume(v);
    set({ sendVolume: v });
  },
  outputVolume: loadNumber(KEYS.outputVolume, 100),
  setOutputVolume: (v) => {
    saveOutputVolume(v);
    set({ outputVolume: v });
  },

  engine: loadEngine(),
  setEngine: (e) => {
    saveEngine(e);
    set({ engine: e });
  },

  micDeviceId: loadMicDeviceId(),
  setMicDeviceId: (id) => {
    saveMicDeviceId(id);
    set({ micDeviceId: id });
  },
  camDeviceId: loadCamDeviceId(),
  setCamDeviceId: (id) => {
    saveCamDeviceId(id);
    set({ camDeviceId: id });
  },

  statusText: '',
  statusState: 'idle',
  setStatus: (text, isError = false, joined) => {
    set((s) => {
      const currentJoined = joined ?? s.joinState === 'joined';
      return {
        statusText: text,
        statusState: isError ? 'err' : currentJoined ? 'ok' : 'idle',
      };
    });
  },

  participants: {},
  upsertParticipant: (partial) => {
    let result!: ParticipantUI;
    set((s) => {
      const existing = s.participants[partial.id];
      const merged: ParticipantUI = existing
        ? { ...existing, ...partial }
        : {
            ...partial,
            display: partial.display ?? `user-${partial.id}`,
            isSelf: Boolean(partial.isSelf),
            selfMuted: partial.selfMuted ?? false,
            speaking: partial.speaking ?? false,
            localMuted: partial.localMuted ?? false,
            localVolume: partial.localVolume ?? 100,
            hasStream: partial.hasStream ?? false,
          };
      const next = { ...s.participants, [partial.id]: merged };
      // Mirror server-side eviction: a peer arriving with a clientId already
      // held by another entry replaces that entry (reconnect race).
      if (partial.clientId) {
        for (const id of Object.keys(next)) {
          if (id !== partial.id && next[id].clientId === partial.clientId) {
            delete next[id];
          }
        }
      }
      result = merged;
      return { participants: next };
    });
    return result;
  },
  removeParticipant: (id) =>
    set((s) => {
      const rest = { ...s.participants };
      delete rest[id];
      return { participants: rest };
    }),
  clearParticipants: () => set({ participants: {} }),
  updateParticipant: (id, patch) =>
    set((s) => {
      const existing = s.participants[id];
      if (!existing) return {};
      return { participants: { ...s.participants, [id]: { ...existing, ...patch } } };
    }),

  chat: [],
  clearChat: () => set({ chat: [] }),
  chatSendOptimistic: (msg) => set((s) => ({ chat: [...s.chat, msg] })),
  chatReceive: (msg) =>
    set((s) => {
      const idx = msg.clientMsgId
        ? s.chat.findIndex((m) => m.clientMsgId === msg.clientMsgId && m.pending)
        : -1;
      if (idx >= 0) {
        const next = [...s.chat];
        next[idx] = msg;
        return { chat: next };
      }
      return { chat: [...s.chat, msg] };
    }),
  chatDelete: (id) => set((s) => ({ chat: s.chat.filter((m) => m.id !== id) })),
  chatUpdateUploadProgress: (clientMsgId, progress) =>
    set((s) => ({
      chat: s.chat.map((m) =>
        m.clientMsgId === clientMsgId ? { ...m, uploadProgress: progress } : m,
      ),
    })),
  chatMarkUploadFailed: (clientMsgId) =>
    set((s) => ({
      chat: s.chat.map((m) =>
        m.clientMsgId === clientMsgId ? { ...m, uploadFailed: true, uploadProgress: undefined } : m,
      ),
    })),
  chatSetAttachments: (clientMsgId, attachments) =>
    set((s) => ({
      chat: s.chat.map((m) => (m.clientMsgId === clientMsgId ? { ...m, attachments } : m)),
    })),
}));
