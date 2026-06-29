// Shared call tiles — reused by the tile-view grid (ParticipantGrid) and the
// speaker-view filmstrip (StageView). A tile fills the box its parent gives it;
// sizing/aspect is decided by the layout, not the tile.

import { useEffect, useRef, useState } from 'react';
import { Maximize2, Mic, MicOff, ScreenShare, Video, Volume2, VolumeX } from 'lucide-react';
import { useStore } from '../store/useStore';
import { useCameraStore } from '../store/useCameraStore';
import { loadPeerVolume, savePeerVolume } from '../utils/storage';
import type { ParticipantUI } from '../types';

export type TileVariant = 'grid' | 'film';

// Read a <video>'s intrinsic aspect ratio and report it upward, so the grid can
// give the tile a box that matches the feed (no cropping).
function useReportAspect(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  active: boolean,
  onAspect?: (ar: number) => void,
) {
  // Keep the callback in a ref so an inline arrow from the parent doesn't
  // re-subscribe the listeners on every render.
  const cbRef = useRef(onAspect);
  cbRef.current = onAspect;
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !active) return;
    const update = () => {
      if (el.videoWidth && el.videoHeight) cbRef.current?.(el.videoWidth / el.videoHeight);
    };
    update();
    el.addEventListener('loadedmetadata', update);
    el.addEventListener('resize', update);
    return () => {
      el.removeEventListener('loadedmetadata', update);
      el.removeEventListener('resize', update);
    };
  }, [videoRef, active]);
}

// Touch devices have no hover, so the hover-revealed tile controls (pin button,
// per-participant volume) are unreachable. On `hover: none` a tap reveals them
// instead — desktop keeps the hover behaviour.
const IS_TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches;

function PinButton({ onClick, label, revealed }: { onClick: () => void; label: string; revealed?: boolean }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 grid place-items-center transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 ${
        revealed ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className="pointer-events-auto grid h-11 w-11 place-items-center border border-white/30 bg-black/55 text-white/90 backdrop-blur transition-colors hover:border-accent hover:text-accent"
      >
        <Maximize2 size={18} />
      </button>
    </div>
  );
}

export function CameraTile({
  participant: p,
  variant = 'grid',
  onLocalAudioChange,
  onPin,
  onAspect,
}: {
  participant: ParticipantUI;
  variant?: TileVariant;
  onLocalAudioChange: () => void;
  onPin?: () => void;
  onAspect?: (ar: number) => void;
}) {
  const selfStream = useCameraStore((s) => (p.isSelf ? s.selfStream : null));
  const remoteStream = useCameraStore((s) => (p.isSelf ? null : s.remoteStreams.get(p.id) ?? null));
  const selfMuted = useStore((s) => s.selfMuted);
  const stream = p.isSelf ? selfStream : remoteStream;
  const showVideo = !!p.cameraOn && !!stream;
  const isRemote = !p.isSelf;
  const isFilm = variant === 'film';

  // On touch, a tap on a grid tile reveals the hover controls (pin + volume).
  const [revealed, setRevealed] = useState(false);
  const tapReveal = IS_TOUCH && !isFilm;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = true;
    if (stream) el.play().catch(() => {});
  }, [stream, showVideo]);

  useReportAspect(videoRef, showVideo, onAspect);

  // Restore this peer's saved volume (keyed by their stable clientId) once known.
  useEffect(() => {
    if (!isRemote || !p.clientId) return;
    const saved = loadPeerVolume(p.clientId);
    if (saved != null && saved !== p.localVolume) {
      useStore.getState().updateParticipant(p.id, { localVolume: saved });
      onLocalAudioChange();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.clientId]);

  const setLocalVolume = (v: number) => {
    useStore.getState().updateParticipant(p.id, { localVolume: v });
    if (p.clientId) savePeerVolume(p.clientId, v);
    onLocalAudioChange();
  };
  const toggleLocalMute = () => {
    useStore.getState().updateParticipant(p.id, { localMuted: !p.localMuted });
    onLocalAudioChange();
  };

  const muted = p.isSelf ? selfMuted : p.remoteMuted;
  const speakingRing = p.speaking && !muted;
  const volPct = ((p.localMuted ? 0 : p.localVolume) / 200) * 100;

  return (
    <div
      onClick={
        isFilm && onPin ? onPin : tapReveal ? () => setRevealed((v) => !v) : undefined
      }
      className={`group relative h-full w-full overflow-hidden border bg-bg-2 ${
        speakingRing ? 'border-accent' : 'border-line'
      } transition-[border-color] duration-150 ${
        (isFilm && onPin) || tapReveal ? 'cursor-pointer' : ''
      }`}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`h-full w-full object-cover ${p.isSelf ? '-scale-x-100' : ''}`}
        />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <div
            className={`grid place-items-center rounded-full bg-bg-3 font-bold uppercase text-muted ${
              isFilm ? 'h-9 w-9 text-[15px]' : 'h-16 w-16 text-[22px]'
            }`}
          >
            {(p.display || '?').trim().charAt(0) || '?'}
          </div>
        </div>
      )}

      {/* Pin-to-stage affordance — centered on hover (desktop) or tap (touch). */}
      {!isFilm && onPin && <PinButton onClick={onPin} label="Развернуть" revealed={revealed} />}

      {!isFilm && isRemote && (
        <div
          onClick={(e) => e.stopPropagation()}
          className={`absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-2.5 py-2 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 ${
            revealed ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <button
            type="button"
            onClick={toggleLocalMute}
            aria-label={p.localMuted ? 'Включить звук участника' : 'Заглушить участника'}
            title={p.localMuted ? 'Включить звук участника' : 'Заглушить участника'}
            className={`grid h-7 w-7 shrink-0 place-items-center ${
              p.localMuted ? 'text-danger' : 'text-white/90 hover:text-accent'
            }`}
          >
            {p.localMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={p.localMuted ? 0 : p.localVolume}
            disabled={p.localMuted}
            onChange={(e) => setLocalVolume(Number(e.target.value))}
            className="vh-range flex-1"
            style={{ '--fill-pct': `${volPct}%` } as React.CSSProperties}
            aria-label="Громкость участника"
          />
          <span className="w-9 shrink-0 text-right text-[11px] text-white/80">{p.localVolume}%</span>
        </div>
      )}

      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent ${
          isFilm ? 'px-1.5 py-1' : 'px-2.5 py-1.5'
        }`}
      >
        <span className={`truncate font-medium text-white ${isFilm ? 'text-[11px]' : 'text-[13px]'}`}>
          {p.display}
          {p.isSelf && <span className="text-muted-2"> · вы</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-white/90">
          {!isFilm && p.screenSharing && <ScreenShare size={14} className="text-accent" />}
          {!isFilm && p.cameraOn && <Video size={14} />}
          {p.localMuted && !p.isSelf && <VolumeX size={isFilm ? 12 : 14} className="text-danger" />}
          {muted ? (
            <MicOff size={isFilm ? 12 : 14} className="text-danger" />
          ) : (
            <Mic size={isFilm ? 12 : 14} className={speakingRing ? 'text-accent' : ''} />
          )}
        </span>
      </div>
    </div>
  );
}

// Live preview of our own screen capture — rendered straight from the local
// MediaStream (no SFU round-trip), muted to avoid system-audio feedback.
export function SelfScreenTile({
  stream,
  variant = 'grid',
  onPin,
  onAspect,
}: {
  stream: MediaStream;
  variant?: TileVariant;
  onPin?: () => void;
  onAspect?: (ar: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isFilm = variant === 'film';
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = true;
    el.play().catch(() => {});
  }, [stream]);
  useReportAspect(videoRef, true, onAspect);

  return (
    <div
      onClick={isFilm && onPin ? onPin : undefined}
      className={`group relative h-full w-full overflow-hidden border border-accent bg-black ${
        isFilm && onPin ? 'cursor-pointer' : ''
      }`}
    >
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
      {!isFilm && onPin && <PinButton onClick={onPin} label="Развернуть" />}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent text-white ${
          isFilm ? 'px-1.5 py-1' : 'px-2.5 py-1.5'
        }`}
      >
        <ScreenShare size={isFilm ? 12 : 14} className="text-accent" />
        <span className={`truncate font-medium ${isFilm ? 'text-[11px]' : 'text-[13px]'}`}>
          Ваш экран
        </span>
      </div>
    </div>
  );
}

// Placeholder tile for a remote screen share — the stream is only pulled once
// it's on stage (bandwidth), so the grid/filmstrip shows an "open" affordance.
export function ScreenShareTile({
  publisherId,
  hasSystemAudio,
  variant = 'grid',
  onPin,
}: {
  publisherId: string;
  hasSystemAudio: boolean;
  variant?: TileVariant;
  onPin: () => void;
}) {
  const display = useStore((s) => s.participants[publisherId]?.display ?? `user-${publisherId}`);
  const isFilm = variant === 'film';

  return (
    <button
      type="button"
      onClick={onPin}
      className="group relative flex h-full w-full flex-col items-center justify-center gap-2
        border border-line bg-bg-2 text-muted transition-colors hover:border-accent hover:text-accent"
    >
      <ScreenShare size={isFilm ? 18 : 26} strokeWidth={2} className="text-accent" />
      {!isFilm && (
        <span className="text-[12px] uppercase tracking-[0.12em] text-muted-2 group-hover:text-accent">
          Открыть экран
        </span>
      )}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent text-white ${
          isFilm ? 'px-1.5 py-1' : 'px-2.5 py-1.5'
        }`}
      >
        <span className={`truncate font-medium ${isFilm ? 'text-[11px]' : 'text-[13px]'}`}>
          {display}
        </span>
        {hasSystemAudio && <Volume2 size={isFilm ? 12 : 14} className="shrink-0" />}
      </div>
    </button>
  );
}

// Compact representation of an audio-only participant (camera off) — a chip so
// it doesn't claim a full video tile. `size` scales up for all-audio calls.
export function AudioChip({
  participant: p,
  size = 'sm',
  onLocalAudioChange,
}: {
  participant: ParticipantUI;
  size?: 'sm' | 'lg';
  onLocalAudioChange: () => void;
}) {
  const selfMuted = useStore((s) => s.selfMuted);
  const muted = p.isSelf ? selfMuted : p.remoteMuted;
  const speakingRing = p.speaking && !muted;
  const lg = size === 'lg';

  const toggleLocalMute = () => {
    if (p.isSelf) return;
    useStore.getState().updateParticipant(p.id, { localMuted: !p.localMuted });
    onLocalAudioChange();
  };

  return (
    <div
      className={`flex items-center gap-2 border bg-bg-2 ${
        speakingRing ? 'border-accent' : 'border-line'
      } transition-[border-color] duration-150 ${lg ? 'flex-col px-4 py-3' : 'px-2.5 py-1.5'}`}
    >
      <div
        className={`relative grid shrink-0 place-items-center rounded-full bg-bg-3 font-bold uppercase text-muted ${
          lg ? 'h-16 w-16 text-[22px]' : 'h-7 w-7 text-[12px]'
        } ${speakingRing ? 'ring-2 ring-accent' : ''}`}
      >
        {(p.display || '?').trim().charAt(0) || '?'}
      </div>
      <div className={`flex min-w-0 items-center gap-1.5 ${lg ? 'flex-col' : ''}`}>
        <span
          className={`truncate font-medium text-body ${lg ? 'max-w-[8rem] text-[13px]' : 'max-w-[7rem] text-[12px]'}`}
        >
          {p.display}
          {p.isSelf && <span className="text-muted-2"> · вы</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {p.localMuted && !p.isSelf && (
            <button
              type="button"
              onClick={toggleLocalMute}
              aria-label="Включить звук участника"
              title="Включить звук участника"
              className="text-danger"
            >
              <VolumeX size={14} />
            </button>
          )}
          {muted ? (
            <MicOff size={14} className="text-danger" />
          ) : (
            <Mic size={14} className={speakingRing ? 'text-accent' : 'text-muted'} />
          )}
        </span>
      </div>
    </div>
  );
}
