import { useEffect, useRef } from 'react';
import { Mic, MicOff, ScreenShare, Video } from 'lucide-react';
import { selectParticipants, useStore } from '../store/useStore';
import { useCameraStore } from '../store/useCameraStore';
import type { ParticipantUI } from '../types';

function gridColumns(count: number): string {
  if (count <= 1) return 'grid-cols-1';
  if (count <= 4) return 'grid-cols-2';
  if (count <= 9) return 'grid-cols-3';
  return 'grid-cols-4';
}

export function ParticipantGrid() {
  const participants = useStore(selectParticipants);
  const cols = gridColumns(participants.length);

  return (
    <div className={`grid gap-3 ${cols} content-start`}>
      {participants.map((p) => (
        <CameraTile key={p.id} participant={p} />
      ))}
    </div>
  );
}

function CameraTile({ participant: p }: { participant: ParticipantUI }) {
  const selfStream = useCameraStore((s) => (p.isSelf ? s.selfStream : null));
  const remoteStream = useCameraStore((s) => (p.isSelf ? null : s.remoteStreams.get(p.id) ?? null));
  const selfMuted = useStore((s) => s.selfMuted);
  const stream = p.isSelf ? selfStream : remoteStream;
  const showVideo = p.cameraOn && !!stream;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = true;
    if (stream) el.play().catch(() => {});
  }, [stream]);

  const muted = p.isSelf ? selfMuted : p.remoteMuted;
  const speakingRing = p.speaking && !muted;

  return (
    <div
      className={`relative aspect-video overflow-hidden border bg-bg-2 ${
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

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-1.5">
        <span className="truncate text-[13px] font-medium text-white">
          {p.display}
          {p.isSelf && <span className="text-muted-2"> · вы</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-white/90">
          {p.screenSharing && <ScreenShare size={14} className="text-accent" />}
          {p.cameraOn && <Video size={14} />}
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
