import { useScreenShareStore } from '../store/useScreenShareStore';
import { selectSelfPeerId, useStore } from '../store/useStore';
import { ScreenShareTile } from './ScreenShareTile';

type Props = {
  onTileClick: (publisherId: string) => void;
};

export function ScreenShareGallery({ onTileClick }: Props) {
  const shares = useScreenShareStore((s) => s.shares);
  const selfId = useStore(selectSelfPeerId);

  const others = Array.from(shares.values()).filter((sh) => sh.publisherId !== selfId);
  if (others.length === 0) return null;

  return (
    <section className="card">
      <h2 className="card-title mb-3">Демонстрации экрана</h2>
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
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
