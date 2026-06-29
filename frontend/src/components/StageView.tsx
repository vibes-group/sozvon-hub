// Speaker view: one pinned feed on a large stage + a filmstrip of everyone
// else. The stage holds either a participant's camera or a screen share (ours
// or a remote one). Replaces the old fullscreen ScreenShareFocused overlay so
// you keep sight of the rest of the room while focusing on one feed.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Grid3x3, Volume2, VolumeX } from 'lucide-react';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useStore, selectParticipants, selectSelfPeerId } from '../store/useStore';
import { useCameraStore } from '../store/useCameraStore';
import { loadScreenAudioVolume, saveScreenAudioVolume } from '../utils/storage';
import { useVideoFps, useVideoStream } from '../screenshare/useVideoFps';
import type { ParticipantUI } from '../types';
import type { StageTarget } from './tileLayout';
import { AudioChip, CameraTile, ScreenShareTile, SelfScreenTile } from './CallTiles';

type Props = {
  stage: StageTarget;
  onSetStage: (target: StageTarget) => void;
  onClose: () => void;
  onLocalAudioChange: () => void;
};

export function StageView({ stage, onSetStage, onClose, onLocalAudioChange }: Props) {
  const participants = useStore(selectParticipants);
  const selfId = useStore(selectSelfPeerId);
  const shares = useScreenShareStore((s) => s.shares);
  const myStream = useScreenShareStore((s) => s.myStream);
  const myStatus = useScreenShareStore((s) => s.myStatus);

  const showSelfShare = myStatus === 'publishing' && !!myStream;
  const otherShares = useMemo(
    () => Array.from(shares.values()).filter((sh) => sh.publisherId !== selfId),
    [shares, selfId],
  );

  // Filmstrip = every tile except the one on stage; keeps room context.
  const onStage = (kind: StageTarget['kind'], id: string) =>
    stage.kind === kind && stage.id === id;

  const stageEl = (() => {
    if (stage.kind === 'screen' && stage.id === selfId && myStream) {
      return <StageSelfScreen stream={myStream} />;
    }
    if (stage.kind === 'screen') {
      return <StageRemoteScreen publisherId={stage.id} />;
    }
    const p = participants.find((x) => x.id === stage.id);
    if (!p) return <div className="grid h-full w-full place-items-center text-muted">Участник вышел</div>;
    return <StageCamera participant={p} />;
  })();

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
      <div className="relative min-h-0 min-w-0 flex-1">
        <button
          type="button"
          onClick={onClose}
          title="Вернуться к сетке"
          aria-label="Вернуться к сетке"
          className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center border border-white/30 bg-black/55 text-white/90 backdrop-blur transition-colors hover:border-accent hover:text-accent"
        >
          <Grid3x3 size={18} />
        </button>
        {stageEl}
      </div>

      <div className="flex shrink-0 gap-2 overflow-x-auto pb-1 lg:w-44 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden lg:pb-0">
        {showSelfShare && selfId && !onStage('screen', selfId) && (
          <FilmBox>
            <SelfScreenTile
              stream={myStream!}
              variant="film"
              onPin={() => onSetStage({ kind: 'screen', id: selfId })}
            />
          </FilmBox>
        )}
        {otherShares
          .filter((sh) => !onStage('screen', sh.publisherId))
          .map((sh) => (
            <FilmBox key={`screen-${sh.publisherId}`}>
              <ScreenShareTile
                publisherId={sh.publisherId}
                hasSystemAudio={sh.hasSystemAudio}
                variant="film"
                onPin={() => onSetStage({ kind: 'screen', id: sh.publisherId })}
              />
            </FilmBox>
          ))}
        {participants.map((p) =>
          p.cameraOn ? (
            !onStage('camera', p.id) && (
              <FilmBox key={p.id}>
                <CameraTile
                  participant={p}
                  variant="film"
                  onLocalAudioChange={onLocalAudioChange}
                  onPin={() => onSetStage({ kind: 'camera', id: p.id })}
                />
              </FilmBox>
            )
          ) : (
            <div key={p.id} className="shrink-0 lg:w-full">
              <AudioChip participant={p} onLocalAudioChange={onLocalAudioChange} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// Fixed-size filmstrip slot: a row of 8rem tiles on mobile, a column of
// full-width tiles on desktop.
function FilmBox({ children }: { children: React.ReactNode }) {
  return <div className="aspect-video w-32 shrink-0 lg:w-full">{children}</div>;
}

function StageCamera({ participant: p }: { participant: ParticipantUI }) {
  const stream = useCameraStore((s) =>
    p.isSelf ? s.selfStream : s.remoteStreams.get(p.id) ?? null,
  );
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = true;
    if (stream) el.play().catch(() => {});
  }, [stream]);

  return (
    <div className="relative grid h-full w-full place-items-center bg-black">
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`h-full w-full object-contain ${p.isSelf ? '-scale-x-100' : ''}`}
        />
      ) : (
        <div className="grid h-28 w-28 place-items-center rounded-full bg-bg-3 text-[40px] font-bold uppercase text-muted">
          {(p.display || '?').trim().charAt(0) || '?'}
        </div>
      )}
      <span className="absolute bottom-3 left-3 truncate rounded bg-black/55 px-2 py-1 text-[13px] font-medium text-white backdrop-blur">
        {p.display}
        {p.isSelf && <span className="text-muted-2"> · вы</span>}
      </span>
    </div>
  );
}

function StageSelfScreen({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = true;
    el.play().catch(() => {});
  }, [stream]);
  return (
    <div className="relative grid h-full w-full place-items-center bg-black">
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
      <span className="absolute bottom-3 left-3 rounded bg-black/55 px-2 py-1 text-[13px] font-medium text-white backdrop-blur">
        Ваш экран
      </span>
    </div>
  );
}

const ENDED_GRACE_MS = 1500;

function StageRemoteScreen({ publisherId }: { publisherId: string }) {
  const videoStream = useScreenShareStore((s) => s.focusedStream);
  const audioStream = useScreenShareStore((s) => s.focusedAudioStream);
  const share = useScreenShareStore((s) => s.shares.get(publisherId));
  const shareLive = !!share;
  const hasSystemAudio = share?.hasSystemAudio ?? false;
  const videoCodec = share?.videoCodec ?? null;
  const publisher = useStore((s) => s.participants[publisherId]);
  const display = publisher?.display ?? `user-${publisherId}`;
  const publisherClientId = publisher?.clientId ?? '';

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioMuted, setAudioMuted] = useState(false);
  const videoSize = useVideoStream(videoRef, videoStream);
  const fps = useVideoFps(videoRef, videoStream);

  const initialVolume = useMemo(() => {
    if (!publisherClientId) return 1;
    const saved = loadScreenAudioVolume(publisherClientId);
    return saved !== null ? Math.max(0, Math.min(1, saved)) : 1;
  }, [publisherClientId]);
  const [volume, setVolume] = useState(initialVolume);

  useEffect(() => {
    setVolume(initialVolume);
  }, [initialVolume]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.srcObject = audioStream;
    el.volume = volume;
    el.muted = audioMuted;
    el.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioStream]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  function toggleAudioMute() {
    const next = !audioMuted;
    setAudioMuted(next);
    if (audioRef.current) audioRef.current.muted = next;
  }

  function onVolumeInput(e: React.ChangeEvent<HTMLInputElement>) {
    const next = Number(e.target.value) / 100;
    setVolume(next);
    if (publisherClientId) saveScreenAudioVolume(publisherClientId, next);
    if (audioMuted && next > 0) {
      setAudioMuted(false);
      if (audioRef.current) audioRef.current.muted = false;
    }
  }

  const qualityLabel = videoSize ? `${videoSize.w}×${videoSize.h}` : null;
  const fpsLabel = fps !== null ? `${Math.round(fps)}fps` : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-black">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-zinc-200">
        <span className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
          <span className="truncate">Экран · {display}</span>
          {videoCodec && (
            <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs font-normal text-zinc-400">
              {videoCodec.toUpperCase()}
            </span>
          )}
          {qualityLabel && (
            <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs font-normal text-zinc-400">
              {qualityLabel}
            </span>
          )}
          {fpsLabel && (
            <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-xs font-normal text-zinc-400">
              {fpsLabel}
            </span>
          )}
        </span>
        {hasSystemAudio && shareLive && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleAudioMute}
              aria-label={audioMuted ? 'Включить звук' : 'Выключить звук'}
              className="rounded p-1 hover:bg-white/10"
            >
              {audioMuted ? (
                <VolumeX size={18} strokeWidth={2.25} />
              ) : (
                <Volume2 size={18} strokeWidth={2.25} />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round((audioMuted ? 0 : volume) * 100)}
              onChange={onVolumeInput}
              aria-label="Громкость звука с экрана"
              className="w-24 accent-zinc-300"
            />
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {videoStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-sm text-zinc-400">
            Подключаюсь к потоку…
          </div>
        )}
        {!shareLive && (
          <div className="absolute inset-0 grid place-items-center bg-black/60 text-sm text-zinc-200">
            Стрим завершён
          </div>
        )}
      </div>
      <audio ref={audioRef} />
    </div>
  );
}

export { ENDED_GRACE_MS };
