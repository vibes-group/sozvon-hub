// Core domain types for sozvon-hub.

import type { DenoiserId } from './audio/denoisers/types';

export type CaptureEngineId = 'browser';
export type EngineKind = 'off' | CaptureEngineId | DenoiserId;

export type AppConfig = {
  iceServers: RTCIceServer[];
};

// UI-only participant state stored in zustand.
// Audio nodes are kept in a separate imperative registry (not reactive).
export type ParticipantUI = {
  id: string;
  display: string;
  // Stable per-install identifier reported by the peer in `hello`. Survives
  // reconnects (peer ids rotate per WS connection). Absent for older clients.
  clientId?: string;
  isSelf: boolean;
  selfMuted: boolean;
  speaking: boolean;
  localMuted: boolean;
  localVolume: number; // 0–500 (WebAudio can exceed 100%)
  hasStream: boolean;
  // Server flags: arrive via peer-info before the media track itself does.
  screenSharing?: boolean;
  cameraOn?: boolean;
  remoteMuted?: boolean;
  remoteDeafened?: boolean;
};
