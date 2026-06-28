// Reactive state for camera video — mirrors useScreenShareStore but simpler
// (no audio, no codec, no focus model). Holds remote camera MediaStreams keyed
// by publisher peer id, plus the local self-preview stream.
//
// MediaStreams live here (not the main store) because the camera tiles read
// them directly to feed `<video>.srcObject`.

import { create } from 'zustand';

export type CameraState = {
  // Remote camera streams keyed by publisher peer id.
  remoteStreams: Map<string, MediaStream>;
  attachRemote: (publisherId: string, stream: MediaStream) => void;
  removeRemote: (publisherId: string) => void;
  clearRemote: () => void;

  // Self camera preview (local capture).
  selfStream: MediaStream | null;
  setSelfStream: (stream: MediaStream | null) => void;
};

export const useCameraStore = create<CameraState>((set) => ({
  remoteStreams: new Map(),
  attachRemote: (publisherId, stream) =>
    set((s) => {
      const m = new Map(s.remoteStreams);
      m.set(publisherId, stream);
      return { remoteStreams: m };
    }),
  removeRemote: (publisherId) =>
    set((s) => {
      if (!s.remoteStreams.has(publisherId)) return {};
      const m = new Map(s.remoteStreams);
      m.delete(publisherId);
      return { remoteStreams: m };
    }),
  clearRemote: () => set({ remoteStreams: new Map() }),

  selfStream: null,
  setSelfStream: (stream) => set({ selfStream: stream }),
}));
