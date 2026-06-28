import { ScreenShare, Volume2 } from 'lucide-react';
import { useStore } from '../store/useStore';

type Props = {
  publisherId: string;
  hasSystemAudio: boolean;
  onClick: () => void;
};

export function ScreenShareTile({ publisherId, hasSystemAudio, onClick }: Props) {
  const display = useStore((s) => s.participants[publisherId]?.display ?? `user-${publisherId}`);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex aspect-video flex-col items-center justify-center gap-2
        border border-line bg-bg-2 text-muted transition-colors hover:border-accent hover:text-accent"
    >
      <ScreenShare size={26} strokeWidth={2} className="text-accent" />
      <span className="text-[12px] uppercase tracking-[0.12em] text-muted-2 group-hover:text-accent">
        Открыть экран
      </span>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-1.5 text-white">
        <span className="truncate text-[13px] font-medium">{display}</span>
        {hasSystemAudio && <Volume2 size={14} className="shrink-0" />}
      </div>
    </button>
  );
}
