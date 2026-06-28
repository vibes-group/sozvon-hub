import { useEffect, useRef } from 'react';
import { Mic, MicOff, ScreenShare, Video, Volume2, VolumeX } from 'lucide-react';
import { selectParticipants, selectSelfPeerId, useStore } from '../store/useStore';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useCameraStore } from '../store/useCameraStore';
import { loadPeerVolume, savePeerVolume } from '../utils/storage';
import type { ParticipantUI } from '../types';
import { ScreenShareTile } from './ScreenShareTile';

function gridColumns(count: number): string {
  if (count <= 1) return 'grid-cols-1';
  if (count <= 4) return 'grid-cols-2';
  if (count <= 9) return 'grid-cols-3';
  return 'grid-cols-4';
}

export function ParticipantGrid({
  onLocalAudioChange,
  onScreenTileClick,
}: {
  onLocalAudioChange: () => void;
  onScreenTileClick: (publisherId: string) => void;
}) {
  const participants = useStore(selectParticipants);
  const selfId = useStore(selectSelfPeerId);
  const shares = useScreenShareStore((s) => s.shares);
  const myStream = useScreenShareStore((s) => s.myStream);
  const myStatus = useScreenShareStore((s) => s.myStatus);

  const otherShares = Array.from(shares.values()).filter((sh) => sh.publisherId !== selfId);
  const showSelfShare = myStatus === 'publishing' && !!myStream;
  const cols = gridColumns(otherShares.length + (showSelfShare ? 1 : 0) + participants.length);

  // Screen shares lead the grid so the demo is the first thing the eye lands on.
  return (
    <div className={`grid gap-3 ${cols} content-start`}>
      {showSelfShare && myStream && <SelfScreenTile stream={myStream} />}
      {otherShares.map((sh) => (
        <ScreenShareTile
          key={`screen-${sh.publisherId}`}
          publisherId={sh.publisherId}
          hasSystemAudio={sh.hasSystemAudio}
          onClick={() => onScreenTileClick(sh.publisherId)}
        />
      ))}
      {participants.map((p) => (
        <CameraTile key={p.id} participant={p} onLocalAudioChange={onLocalAudioChange} />
      ))}
    </div>
  );
}

// Live preview of our own screen capture — rendered straight from the local
// MediaStream (no SFU round-trip), muted to avoid system-audio feedback.
function SelfScreenTile({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = true;
    el.play().catch(() => {});
  }, [stream]);

  return (
    <div className="relative aspect-video overflow-hidden border border-accent bg-black">
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-1.5 text-white">
        <ScreenShare size={14} className="text-accent" />
        <span className="truncate text-[13px] font-medium">Ваш экран</span>
      </div>
    </div>
  );
}

function CameraTile({
  participant: p,
  onLocalAudioChange,
}: {
  participant: ParticipantUI;
  onLocalAudioChange: () => void;
}) {
  const selfStream = useCameraStore((s) => (p.isSelf ? s.selfStream : null));
  const remoteStream = useCameraStore((s) => (p.isSelf ? null : s.remoteStreams.get(p.id) ?? null));
  const selfMuted = useStore((s) => s.selfMuted);
  const stream = p.isSelf ? selfStream : remoteStream;
  const showVideo = p.cameraOn && !!stream;
  const isRemote = !p.isSelf;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = true;
    if (stream) el.play().catch(() => {});
  }, [stream, showVideo]);

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
      className={`group relative aspect-video overflow-hidden border bg-bg-2 ${
        speakingRing ? 'border-accent' : 'border-line'
      } transition-[border-color] duration-150`}
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
          <div className="grid h-16 w-16 place-items-center rounded-full bg-bg-3 text-[22px] font-bold uppercase text-muted">
            {(p.display || '?').trim().charAt(0) || '?'}
          </div>
        </div>
      )}

      {isRemote && (
        <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-2.5 py-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
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

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-1.5">
        <span className="truncate text-[13px] font-medium text-white">
          {p.display}
          {p.isSelf && <span className="text-muted-2"> · вы</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-white/90">
          {p.screenSharing && <ScreenShare size={14} className="text-accent" />}
          {p.cameraOn && <Video size={14} />}
          {p.localMuted && !p.isSelf && <VolumeX size={14} className="text-danger" />}
          {muted ? (
            <MicOff size={14} className="text-danger" />
          ) : (
            <Mic size={14} className={speakingRing ? 'text-accent' : ''} />
          )}
        </span>
      </div>
    </div>
  );
}
