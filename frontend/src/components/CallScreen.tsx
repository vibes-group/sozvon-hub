import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { useSFU } from '../hooks/useSFU';
import { useSessionManager } from '../hooks/useSessionManager';
import { formatEngine, preloadEngine } from '../audio/engine';
import { playMuteSound, playUnmuteSound } from '../audio/feedback-sounds';
import type { EngineKind } from '../types';
import { ControlsBar } from './ControlsBar';
import { ParticipantGrid } from './ParticipantGrid';
import { ChatPanel } from './ChatPanel';
import { DeviceSettings } from './DeviceSettings';
import { ScreenShareGallery } from './ScreenShareGallery';
import { ScreenShareFocused } from './ScreenShareFocused';

type Props = {
  roomSlug: string;
  displayName: string;
  onLeave: () => void;
};

export function CallScreen({ roomSlug, displayName, onLeave }: Props) {
  const audio = useAudioEngine();
  const sfu = useSFU();
  const session = useSessionManager({ audio, sfu, roomSlug });

  const configReady = useStore((s) => s.configReady);
  const joinState = useStore((s) => s.joinState);
  const statusText = useStore((s) => s.statusText);
  const statusState = useStore((s) => s.statusState);

  // Join once config is ready. Guard against re-joining (StrictMode double-mount,
  // re-renders) via a ref.
  const joinedOnceRef = useRef(false);
  useEffect(() => {
    if (!configReady || joinedOnceRef.current) return;
    joinedOnceRef.current = true;
    void session.join(displayName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configReady]);

  // Leave on unmount.
  useEffect(() => {
    return () => {
      session.leave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleMic = useCallback(() => {
    const s = useStore.getState();
    const joined = session.getPeerId() !== null;
    if (s.deafened) {
      s.setDeafened(false);
      audio.applyAllRemoteGains();
    }
    const nextMuted = !s.selfMuted;
    s.setSelfMuted(nextMuted);
    if (joined) {
      session.setMicEnabled(!nextMuted);
      session.sendSetState(nextMuted, false);
    }
    if (nextMuted) playMuteSound();
    else playUnmuteSound();
  }, [audio, session]);

  const handleToggleDeafen = useCallback(() => {
    const s = useStore.getState();
    const joined = session.getPeerId() !== null;
    if (s.deafened) {
      s.setDeafened(false);
      s.setSelfMuted(s.preDeafenSelfMuted);
      if (joined) {
        session.setMicEnabled(!s.preDeafenSelfMuted);
        session.sendSetState(s.preDeafenSelfMuted, false);
      }
    } else {
      s.enterDeafen();
      if (joined) {
        session.setMicEnabled(false);
        session.sendSetState(true, true);
      }
    }
    audio.applyAllRemoteGains();
  }, [audio, session]);

  const handleToggleCamera = useCallback(() => {
    const on = useStore.getState().cameraOn;
    if (on) session.stopCamera();
    else void session.startCamera();
  }, [session]);

  const [shareBusy, setShareBusy] = useState(false);
  const handleToggleScreenShare = useCallback(() => {
    if (shareBusy) return;
    const status = useScreenShareStore.getState().myStatus;
    setShareBusy(true);
    const done = () => setShareBusy(false);
    if (status === 'publishing' || status === 'starting') {
      session.stopScreenShare();
      done();
    } else {
      void session.startScreenShare().finally(done);
    }
  }, [session, shareBusy]);

  const handleLeave = useCallback(() => {
    session.leave();
    onLeave();
  }, [session, onLeave]);

  const handleEngineSelect = useCallback(
    async (engine: EngineKind) => {
      const s = useStore.getState();
      if (engine === s.engine) return;
      s.setEngine(engine);
      preloadEngine(engine);
      if (s.joinState !== 'joined') {
        s.setStatus(`Шумоподавление: ${formatEngine(engine)}`);
        return;
      }
      s.setStatus(`Переключаюсь на ${formatEngine(engine)}…`);
      try {
        await session.switchEngine(engine);
        useStore.getState().setStatus(`Шумоподавление: ${formatEngine(engine)}`, false, true);
      } catch (err) {
        useStore
          .getState()
          .setStatus(
            `Не удалось переключить шумоподавление: ${err instanceof Error ? err.message : String(err)}`,
            true,
            true,
          );
      }
    },
    [session],
  );

  const handleMicDeviceSelect = useCallback(
    async (deviceId: string | null) => {
      const s = useStore.getState();
      if (deviceId === s.micDeviceId) return;
      s.setMicDeviceId(deviceId);
      if (s.joinState !== 'joined') return;
      s.setStatus('Переключаю микрофон…');
      try {
        await session.switchMicDevice();
        useStore.getState().setStatus('Микрофон переключён.', false, true);
      } catch (err) {
        useStore
          .getState()
          .setStatus(
            `Не удалось переключить микрофон: ${err instanceof Error ? err.message : String(err)}`,
            true,
            true,
          );
      }
    },
    [session],
  );

  const handleOutputVolumeChange = useCallback(
    (v: number) => {
      useStore.getState().setOutputVolume(v);
      audio.applyAllRemoteGains();
    },
    [audio],
  );

  const handleTileClick = useCallback(
    (publisherId: string) => {
      const share = useScreenShareStore.getState();
      const prev = share.focusedId;
      if (prev === publisherId) return;
      if (prev) session.unsubscribeScreenShare(prev);
      share.setFocused(publisherId);
      session.subscribeScreenShare(publisherId);
    },
    [session],
  );

  const handleFocusedClose = useCallback(() => {
    const share = useScreenShareStore.getState();
    const focused = share.focusedId;
    if (focused) session.unsubscribeScreenShare(focused);
    share.setFocused(null);
  }, [session]);

  return (
    <>
      <ScreenShareFocused onClose={handleFocusedClose} />
      <main className="min-h-dvh bg-bg-0 text-body flex flex-col">
        <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-line">
          <div className="flex items-baseline gap-3 min-w-0">
            <button
              type="button"
              onClick={handleLeave}
              title="На главную"
              className="text-[15px] font-semibold tracking-tight text-text transition-colors hover:text-accent"
            >
              sozvon
            </button>
            <span className="text-[12px] text-muted-2 uppercase tracking-[0.12em] truncate">
              комната {roomSlug}
            </span>
          </div>
          <span
            className={`text-[12px] truncate ${
              statusState === 'err' ? 'text-danger' : statusState === 'ok' ? 'text-good' : 'text-muted-2'
            }`}
          >
            {statusText}
          </span>
        </header>

        <div className="flex-1 grid gap-4 p-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
          <div className="grid gap-4 content-start min-w-0">
            <ScreenShareGallery onTileClick={handleTileClick} />
            <ParticipantGrid onLocalAudioChange={audio.applyAllRemoteGains} />
          </div>
          <div className="grid gap-4 content-start lg:h-[calc(100dvh-150px)] lg:grid-rows-[auto_minmax(0,1fr)]">
            <DeviceSettings
              onEngineSelect={handleEngineSelect}
              onMicDeviceSelect={handleMicDeviceSelect}
              onOutputVolumeChange={handleOutputVolumeChange}
            />
            <ChatPanel onSend={session.sendChat} onDelete={session.sendChatDelete} />
          </div>
        </div>

        <footer className="sticky bottom-0 border-t border-line bg-bg-0/95 backdrop-blur px-4 py-3">
          <ControlsBar
            onToggleMic={handleToggleMic}
            onToggleCamera={handleToggleCamera}
            onToggleScreenShare={handleToggleScreenShare}
            onToggleDeafen={handleToggleDeafen}
            onLeave={handleLeave}
          />
        </footer>
      </main>
      {joinState === 'joining' && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-bg-0/80">
          <span className="text-[13px] uppercase tracking-[0.14em] text-muted">{statusText || 'Подключаюсь…'}</span>
        </div>
      )}
    </>
  );
}
