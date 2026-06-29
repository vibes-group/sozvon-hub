import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  SwitchCamera,
  ScreenShare,
  ScreenShareOff,
  Headphones,
  PhoneOff,
} from 'lucide-react';
import { useStore } from '../store/useStore';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useInputDevices } from '../utils/devices';

type Props = {
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onFlipCamera?: () => void;
  onToggleScreenShare: () => void;
  onToggleDeafen: () => void;
  onLeave: () => void;
  // Hidden on devices without getDisplayMedia (mobile browsers).
  canScreenShare?: boolean;
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

// Camera control. With a single camera (or while off) it's a plain toggle; with
// the camera on and a front/back pair available it splits into two: the main
// area toggles the camera, the attached strip flips to the next camera.
function CameraControl({
  cameraOn,
  canFlip,
  onToggle,
  onFlip,
}: {
  cameraOn: boolean;
  canFlip: boolean;
  onToggle: () => void;
  onFlip: () => void;
}) {
  if (!cameraOn || !canFlip) {
    return (
      <Ctrl
        label={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
        active={cameraOn}
        onClick={onToggle}
      >
        {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
      </Ctrl>
    );
  }
  return (
    <div className="flex h-12 border border-accent bg-[rgba(75,226,119,0.1)] text-accent">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Выключить камеру"
        title="Выключить камеру"
        className="grid w-10 place-items-center transition-colors duration-150 active:translate-y-px hover:bg-[rgba(75,226,119,0.18)]"
      >
        <Video size={20} />
      </button>
      <button
        type="button"
        onClick={onFlip}
        aria-label="Сменить камеру"
        title="Сменить камеру"
        className="grid w-9 place-items-center border-l border-accent/40 transition-colors duration-150 active:translate-y-px hover:bg-[rgba(75,226,119,0.18)]"
      >
        <SwitchCamera size={18} />
      </button>
    </div>
  );
}

export function ControlsBar({
  onToggleMic,
  onToggleCamera,
  onFlipCamera,
  onToggleScreenShare,
  onToggleDeafen,
  onLeave,
  canScreenShare = true,
}: Props) {
  const selfMuted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.deafened);
  const cameraOn = useStore((s) => s.cameraOn);
  const sharing = useScreenShareStore((s) => s.myStatus === 'publishing' || s.myStatus === 'starting');
  // ≥2 cameras means a front/back pair (phones) where a quick flip makes sense.
  // Pass cameraOn so the list re-reads once permission populates device ids.
  const canFlip = useInputDevices('videoinput', cameraOn).length >= 2 && !!onFlipCamera;

  return (
    <div className="flex items-center justify-center gap-3 flex-wrap">
      <CameraControl
        cameraOn={cameraOn}
        canFlip={canFlip}
        onToggle={onToggleCamera}
        onFlip={() => onFlipCamera?.()}
      />
      {canScreenShare && (
        <Ctrl
          label={sharing ? 'Остановить показ экрана' : 'Показать экран'}
          active={sharing}
          onClick={onToggleScreenShare}
        >
          {sharing ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
        </Ctrl>
      )}
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
