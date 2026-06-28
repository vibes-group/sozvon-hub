import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  ScreenShare,
  ScreenShareOff,
  Headphones,
  PhoneOff,
} from 'lucide-react';
import { useStore } from '../store/useStore';
import { useScreenShareStore } from '../store/useScreenShareStore';

type Props = {
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleDeafen: () => void;
  onLeave: () => void;
};

type CtrlProps = {
  label: string;
  active: boolean;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
};

// Tone precedence: danger (red = off) > active (green = on) > neutral (gray).
function Ctrl({ label, active, danger, onClick, children }: CtrlProps) {
  const tone = danger
    ? 'border-danger text-danger bg-[rgba(248,113,113,0.08)] hover:bg-danger hover:text-accent-ink'
    : active
      ? 'border-accent text-accent bg-[rgba(75,226,119,0.1)]'
      : 'border-line text-muted bg-bg-1 hover:border-muted hover:text-text';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid h-12 w-12 place-items-center border transition-colors duration-150 active:translate-y-px ${tone}`}
    >
      {children}
    </button>
  );
}

export function ControlsBar({
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onToggleDeafen,
  onLeave,
}: Props) {
  const selfMuted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.deafened);
  const cameraOn = useStore((s) => s.cameraOn);
  const sharing = useScreenShareStore((s) => s.myStatus === 'publishing' || s.myStatus === 'starting');

  return (
    <div className="flex items-center justify-center gap-3 flex-wrap">
      <Ctrl label={cameraOn ? 'Выключить камеру' : 'Включить камеру'} active={cameraOn} onClick={onToggleCamera}>
        {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
      </Ctrl>
      <Ctrl
        label={sharing ? 'Остановить показ экрана' : 'Показать экран'}
        active={sharing}
        onClick={onToggleScreenShare}
      >
        {sharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
      </Ctrl>
      <Ctrl
        label={selfMuted ? 'Включить микрофон' : 'Выключить микрофон'}
        active={!selfMuted}
        danger={selfMuted}
        onClick={onToggleMic}
      >
        {selfMuted ? <MicOff size={20} /> : <Mic size={20} />}
      </Ctrl>
      <Ctrl
        label={deafened ? 'Включить звук' : 'Выключить звук'}
        active={!deafened}
        danger={deafened}
        onClick={onToggleDeafen}
      >
        <Headphones size={20} />
      </Ctrl>
      <Ctrl label="Выйти" active={false} danger onClick={onLeave}>
        <PhoneOff size={20} />
      </Ctrl>
    </div>
  );
}
