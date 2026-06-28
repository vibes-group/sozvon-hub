import { useEffect, useRef } from 'react';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { selectSelfPeerId, useStore } from '../store/useStore';
import { ScreenShareTile } from './ScreenShareTile';

type Props = {
  onTileClick: (publisherId: string) => void;
};

export function ScreenShareGallery({ onTileClick }: Props) {
  const shares = useScreenShareStore((s) => s.shares);
  const myStream = useScreenShareStore((s) => s.myStream);
  const myStatus = useScreenShareStore((s) => s.myStatus);
  const selfId = useStore(selectSelfPeerId);

  const others = Array.from(shares.values()).filter((sh) => sh.publisherId !== selfId);
  const showSelf = myStatus === 'publishing' && !!myStream;
  if (others.length === 0 && !showSelf) return null;

  return (
    <section className="card">
      <h2 className="card-title mb-3">Демонстрации экрана</h2>
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
        {showSelf && <SelfScreenTile stream={myStream} />}
        {others.map((sh) => (
          <ScreenShareTile
            key={sh.publisherId}
            publisherId={sh.publisherId}
            hasSystemAudio={sh.hasSystemAudio}
            onClick={() => onTileClick(sh.publisherId)}
          />
        ))}
      </div>
    </section>
  );
}

// Live preview of our own screen capture — rendered directly from the local
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
    <div className="relative aspect-video overflow-hidden rounded-md border border-accent bg-black">
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
      <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-white">
        Ваш экран
      </span>
    </div>
  );
}
