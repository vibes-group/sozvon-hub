import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutGrid, MessageSquare, Presentation, Share2, SlidersHorizontal, X } from 'lucide-react';
import { shareRoom } from '../api';
import { selectParticipants, selectSelfPeerId, useStore } from '../store/useStore';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useCameraStore } from '../store/useCameraStore';
import { listInputDevices } from '../utils/devices';
import { useAudioEngine } from '../hooks/useAudioEngine';
import { useSFU } from '../hooks/useSFU';
import { useSessionManager } from '../hooks/useSessionManager';
import { formatEngine, preloadEngine } from '../audio/engine';
import { playMuteSound, playUnmuteSound } from '../audio/feedback-sounds';
import type { EngineKind } from '../types';
import { ControlsBar } from './ControlsBar';
import { ParticipantGrid } from './ParticipantGrid';
import { StageView, ENDED_GRACE_MS } from './StageView';
import type { StageTarget } from './tileLayout';
import { ChatPanel } from './ChatPanel';
import { DeviceSettings } from './DeviceSettings';
import { ScreenShareSettings } from './ScreenShareSettings';

// Mobile browsers (iOS Safari, Android Chrome) don't implement getDisplayMedia,
// so screen sharing is simply unavailable there — hide the control rather than
// let it fail confusingly.
const SCREEN_SHARE_SUPPORTED =
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

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
  const selfId = useStore(selectSelfPeerId);
  const setStatus = useStore((s) => s.setStatus);
  const participants = useStore(selectParticipants);
  const shares = useScreenShareStore((s) => s.shares);
  const myShareStatus = useScreenShareStore((s) => s.myStatus);

  // Chat is a togglable right drawer; settings live in a modal. Both start
  // closed so the call grid gets the full width.
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [name, setName] = useState(displayName);

  // Speaker view: one feed (camera or screen) on a large stage. null = tile grid.
  const [stage, setStage] = useState<StageTarget | null>(null);

  const handleShare = useCallback(async () => {
    const result = await shareRoom(roomSlug);
    if (result === 'copied') setStatus('Ссылка скопирована');
    else if (result === 'shared') setStatus('Ссылкой поделились');
  }, [roomSlug, setStatus]);

  const handleNameChange = useCallback(
    (v: string) => {
      setName(v);
      if (v.trim()) session.setRemoteDisplayName(v.trim());
    },
    [session],
  );

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

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
    if (!SCREEN_SHARE_SUPPORTED) {
      useStore.getState().setStatus('Показ экрана не поддерживается в этом браузере.', true, true);
      return;
    }
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

  const handleCamDeviceSelect = useCallback(
    async (deviceId: string | null) => {
      const s = useStore.getState();
      if (deviceId === s.camDeviceId) return;
      s.setCamDeviceId(deviceId);
      // Only swap the live track when the camera is actually on; otherwise the
      // new device applies the next time it's turned on.
      if (s.joinState !== 'joined' || !s.cameraOn) return;
      s.setStatus('Переключаю камеру…');
      try {
        await session.switchCamDevice();
        useStore.getState().setStatus('Камера переключена.', false, true);
      } catch (err) {
        useStore
          .getState()
          .setStatus(
            `Не удалось переключить камеру: ${err instanceof Error ? err.message : String(err)}`,
            true,
            true,
          );
      }
    },
    [session],
  );

  // Quick camera flip (mobile): cycle to the next video device. Reuses the
  // device-select path, which live-swaps the published track when the camera
  // is on.
  const handleFlipCamera = useCallback(async () => {
    try {
      const cams = await listInputDevices('videoinput');
      if (cams.length < 2) return;
      // Use the live track's real deviceId, not the stored camDeviceId — the
      // latter is null when the camera started on the default device, which
      // would make us cycle back to the camera already in use.
      const liveId = useCameraStore
        .getState()
        .selfStream?.getVideoTracks()[0]
        ?.getSettings().deviceId;
      const cur = liveId ?? useStore.getState().camDeviceId;
      const idx = cams.findIndex((d) => d.deviceId === cur);
      const next = cams[(idx + 1) % cams.length];
      if (next.deviceId !== cur) await handleCamDeviceSelect(next.deviceId);
    } catch {
      /* ignore — enumeration can fail before permission is granted */
    }
  }, [handleCamDeviceSelect]);

  const handleSendVolumeChange = useCallback(
    (v: number) => {
      useStore.getState().setSendVolume(v);
      audio.updateSendGain();
    },
    [audio],
  );

  const handleOutputVolumeChange = useCallback(
    (v: number) => {
      useStore.getState().setOutputVolume(v);
      audio.applyAllRemoteGains();
    },
    [audio],
  );

  const handleReset = useCallback(() => {
    const s = useStore.getState();
    s.setSendVolume(100);
    audio.updateSendGain();
    s.setOutputVolume(100);
    audio.applyAllRemoteGains();
    void handleEngineSelect('browser');
    void handleMicDeviceSelect(null);
    void handleCamDeviceSelect(null);
    useStore.getState().setStatus('Настройки сброшены.', false, true);
  }, [audio, handleEngineSelect, handleMicDeviceSelect, handleCamDeviceSelect]);

  // Promote a feed to the stage (from a grid tile or a filmstrip swap).
  const handlePin = useCallback((target: StageTarget) => setStage(target), []);
  const handleStageClose = useCallback(() => setStage(null), []);

  // Pick a sensible feed for the grid⇄speaker toggle: a screen if any, else a
  // remote camera, else our own camera.
  const pickDefaultStage = useCallback((): StageTarget | null => {
    const share = useScreenShareStore.getState();
    for (const sh of share.shares.values()) {
      if (sh.publisherId !== selfId) return { kind: 'screen', id: sh.publisherId };
    }
    if (share.myStatus === 'publishing' && share.myStream && selfId) {
      return { kind: 'screen', id: selfId };
    }
    const remoteCam = participants.find((p) => !p.isSelf && p.cameraOn);
    if (remoteCam) return { kind: 'camera', id: remoteCam.id };
    const selfCam = participants.find((p) => p.isSelf && p.cameraOn);
    if (selfCam) return { kind: 'camera', id: selfCam.id };
    return null;
  }, [participants, selfId]);

  const handleToggleView = useCallback(() => {
    if (stage) setStage(null);
    else {
      const t = pickDefaultStage();
      if (t) setStage(t);
    }
  }, [stage, pickDefaultStage]);

  // Keep the screen-share subscription in lockstep with the stage. Only remote
  // screens are pulled from the SFU; our own screen plays from the local stream.
  useEffect(() => {
    const share = useScreenShareStore.getState();
    const want = stage?.kind === 'screen' && stage.id !== selfId ? stage.id : null;
    if (want) {
      if (share.focusedId !== want) {
        if (share.focusedId) session.unsubscribeScreenShare(share.focusedId);
        share.setFocused(want);
        session.subscribeScreenShare(want);
      }
    } else if (share.focusedId) {
      session.unsubscribeScreenShare(share.focusedId);
      share.setFocused(null);
    }
  }, [stage, selfId, session]);

  // Auto-promote a freshly started remote screen share — but never yank the
  // user off a stage they already chose.
  const prevShareIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(
      Array.from(shares.values())
        .map((sh) => sh.publisherId)
        .filter((id) => id !== selfId),
    );
    // Sort so that when several shares start in the same render the
    // auto-promoted one is the same on every client.
    const fresh =
      [...ids].filter((id) => !prevShareIdsRef.current.has(id)).sort()[0] ?? null;
    prevShareIdsRef.current = ids;
    if (fresh && !stage) setStage({ kind: 'screen', id: fresh });
  }, [shares, selfId, stage]);

  // A screen on stage that ended: show "стрим завершён" briefly, then drop to grid.
  useEffect(() => {
    if (stage?.kind !== 'screen' || stage.id === selfId || shares.has(stage.id)) return;
    const t = setTimeout(
      () => setStage((cur) => (cur?.kind === 'screen' && cur.id === stage.id ? null : cur)),
      ENDED_GRACE_MS,
    );
    return () => clearTimeout(t);
  }, [stage, shares, selfId]);

  // Our own screen on stage stopped → back to grid.
  useEffect(() => {
    if (stage?.kind === 'screen' && stage.id === selfId && myShareStatus !== 'publishing') {
      setStage(null);
    }
  }, [stage, selfId, myShareStatus]);

  // A pinned participant left the room → back to grid.
  useEffect(() => {
    if (stage?.kind === 'camera' && !participants.some((p) => p.id === stage.id)) setStage(null);
  }, [stage, participants]);

  return (
    <>
      <main className="h-dvh overflow-hidden bg-bg-0 text-body flex flex-col">
        <header className="flex items-center justify-between gap-2 sm:gap-3 px-3 sm:px-5 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] border-b border-line shrink-0">
          <div className="flex items-baseline gap-2 sm:gap-3 min-w-0">
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
          <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
            <span
              className={`hidden sm:block text-[12px] truncate ${
                statusState === 'err' ? 'text-danger' : statusState === 'ok' ? 'text-good' : 'text-muted-2'
              }`}
            >
              {statusText}
            </span>
            <HeaderButton label="Поделиться" onClick={handleShare}>
              <Share2 size={18} />
            </HeaderButton>
            <HeaderButton
              label={stage ? 'Сетка' : 'Докладчик'}
              active={!!stage}
              onClick={handleToggleView}
            >
              {stage ? <LayoutGrid size={18} /> : <Presentation size={18} />}
            </HeaderButton>
            <HeaderButton label="Чат" active={chatOpen} onClick={() => setChatOpen((v) => !v)}>
              <MessageSquare size={18} />
            </HeaderButton>
            <HeaderButton
              label="Настройки"
              active={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
            >
              <SlidersHorizontal size={18} />
            </HeaderButton>
          </div>
        </header>

        {statusState === 'err' && statusText && (
          <div
            role="alert"
            className="shrink-0 border-b border-danger bg-[rgba(248,113,113,0.12)] px-4 py-2 text-[13px] text-danger sm:hidden"
          >
            {statusText}
          </div>
        )}

        <div className="flex-1 min-h-0 flex">
          <section
            className={`flex-1 min-w-0 min-h-0 overflow-hidden p-4 ${
              chatOpen ? 'hidden md:block' : ''
            }`}
          >
            {stage ? (
              <StageView
                stage={stage}
                onSetStage={handlePin}
                onClose={handleStageClose}
                onLocalAudioChange={audio.applyAllRemoteGains}
              />
            ) : (
              <ParticipantGrid onLocalAudioChange={audio.applyAllRemoteGains} onPin={handlePin} />
            )}
          </section>
          {chatOpen && (
            <div className="w-full md:max-w-[380px] shrink-0 flex flex-col min-h-0 p-3 md:pl-0">
              <ChatPanel
                roomId={roomSlug}
                onSend={session.sendChat}
                onDelete={session.sendChatDelete}
              />
            </div>
          )}
        </div>

        <footer className="border-t border-line bg-bg-0/95 backdrop-blur px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shrink-0">
          <ControlsBar
            onToggleMic={handleToggleMic}
            onToggleCamera={handleToggleCamera}
            onFlipCamera={handleFlipCamera}
            onToggleScreenShare={handleToggleScreenShare}
            onToggleDeafen={handleToggleDeafen}
            onLeave={handleLeave}
            canScreenShare={SCREEN_SHARE_SUPPORTED}
          />
        </footer>
      </main>

      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-start justify-center overflow-y-auto bg-black/60 p-4 sm:py-10"
          onClick={() => setSettingsOpen(false)}
        >
          <div className="w-full max-w-md grid gap-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-bold uppercase tracking-[0.18em] text-muted-2">
                Настройки звонка
              </span>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Закрыть настройки"
                className="grid h-9 w-9 place-items-center border border-line bg-bg-1 text-muted hover:border-accent hover:text-accent"
              >
                <X size={18} />
              </button>
            </div>
            <section className="card grid gap-3">
              <h2 className="card-title">Профиль</h2>
              <label className="grid gap-1.5">
                <span className="section-label">Ваше имя</span>
                <input
                  className="input-field mt-0 text-accent font-medium"
                  value={name}
                  maxLength={48}
                  placeholder="Имя"
                  onChange={(e) => handleNameChange(e.target.value)}
                />
              </label>
            </section>
            <DeviceSettings
              onEngineSelect={handleEngineSelect}
              onMicDeviceSelect={handleMicDeviceSelect}
              onCamDeviceSelect={handleCamDeviceSelect}
              onSendVolumeChange={handleSendVolumeChange}
              onOutputVolumeChange={handleOutputVolumeChange}
              onReset={handleReset}
            />
            {SCREEN_SHARE_SUPPORTED && (
              <ScreenShareSettings
                onLiveUpdate={() => void session.updateScreenShareParams()}
                onShareModeChange={(mode) => void session.changeScreenShareMode(mode)}
              />
            )}
          </div>
        </div>
      )}

      {joinState === 'joining' && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-bg-0/80">
          <span className="text-[13px] uppercase tracking-[0.14em] text-muted">{statusText || 'Подключаюсь…'}</span>
        </div>
      )}
    </>
  );
}

function HeaderButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`grid h-9 w-9 place-items-center border transition-colors ${
        active
          ? 'border-accent text-accent bg-[rgba(75,226,119,0.1)]'
          : 'border-line text-muted hover:border-muted hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}
