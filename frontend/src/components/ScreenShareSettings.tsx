import { useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  useScreenShareSettingsStore,
  useEffectiveScreenSettings,
} from '../store/useScreenShareSettingsStore';
import { useScreenShareStore } from '../store/useScreenShareStore';
import {
  SCREEN_PRESETS,
  SCREEN_RESOLUTIONS,
  SCREEN_FPS_OPTIONS,
  type ScreenMode,
  type ScreenResolution,
  type ScreenFps,
  type ScreenCodecPref,
  type ShareMode,
} from '../screenshare/params';

const RESOLUTION_LABELS: Record<ScreenResolution, string> = {
  source: 'Источник',
  '720': '720p',
  '1080': '1080p',
  '1440': '1440p',
  '2160': '2160p (4K)',
};
const SHARE_MODE_LABELS: Record<ShareMode, string> = {
  sharp: 'Чёткость',
  motion: 'Плавность',
};
const CODEC_LABELS: Record<ScreenCodecPref, string> = {
  av1: 'AV1 (рекомендуется)',
  vp9: 'VP9',
};
const MODE_LABELS: { id: ScreenMode; label: string }[] = [
  ...SCREEN_PRESETS.map((p) => ({ id: p.id as ScreenMode, label: p.label })),
  { id: 'custom', label: 'Вручную' },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  );
}

function Select<T extends string | number>({
  value,
  options,
  labels,
  disabled,
  ariaLabel,
  onChange,
}: {
  value: T;
  options: readonly T[];
  labels: (v: T) => string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="relative">
      <select
        aria-label={ariaLabel}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          const next = (typeof value === 'number' ? Number(raw) : raw) as T;
          onChange(next);
        }}
        className="appearance-none w-full pl-3 pr-9 py-2.5 text-[13px]
          bg-bg-input border border-line text-muted cursor-pointer
          hover:border-muted-2 focus:outline-none focus:border-accent transition-colors
          disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {labels(opt)}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-2 pointer-events-none"
      />
    </div>
  );
}

type Props = {
  // Re-apply capture constraints / encoder params to a live share.
  onLiveUpdate: () => void;
  // Tell the SFU the adaptation policy changed (sharp/motion).
  onShareModeChange: (mode: ShareMode) => void;
};

export function ScreenShareSettings({ onLiveUpdate, onShareModeChange }: Props) {
  const mode = useScreenShareSettingsStore((s) => s.mode);
  const codec = useScreenShareSettingsStore((s) => s.codec);
  const customResolution = useScreenShareSettingsStore((s) => s.customResolution);
  const customFps = useScreenShareSettingsStore((s) => s.customFps);
  const setMode = useScreenShareSettingsStore((s) => s.setMode);
  const setShareMode = useScreenShareSettingsStore((s) => s.setShareMode);
  const setCodec = useScreenShareSettingsStore((s) => s.setCodec);
  const setResolution = useScreenShareSettingsStore((s) => s.setResolution);
  const setFps = useScreenShareSettingsStore((s) => s.setFps);

  const eff = useEffectiveScreenSettings();
  const publishing = useScreenShareStore(
    (s) => s.myStatus === 'publishing' || s.myStatus === 'starting',
  );
  const isCustom = mode === 'custom';

  // Coalesce rapid slider/select edits into one re-apply on a live share.
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleLive = () => {
    if (!publishing) return;
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => onLiveUpdate(), 250);
  };

  const handleMode = (m: ScreenMode) => {
    setMode(m);
    const nextShareMode = m === 'custom' ? eff.shareMode : getPresetShareMode(m);
    if (publishing) onShareModeChange(nextShareMode);
    scheduleLive();
  };

  return (
    <section className="card grid gap-4">
      <h2 className="card-title">Показ экрана</h2>

      <Field label="Режим">
        <div className="grid grid-cols-3 gap-1.5">
          {MODE_LABELS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => handleMode(m.id)}
              className={`py-2 text-[12px] uppercase tracking-[0.08em] border transition-colors ${
                mode === m.id
                  ? 'border-accent text-accent bg-[rgba(75,226,119,0.1)]'
                  : 'border-line text-muted hover:border-muted-2'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Разрешение">
        <Select
          ariaLabel="Разрешение"
          value={isCustom ? customResolution : eff.resolution}
          options={SCREEN_RESOLUTIONS}
          labels={(v) => RESOLUTION_LABELS[v]}
          disabled={!isCustom}
          onChange={(v) => {
            setResolution(v);
            scheduleLive();
          }}
        />
      </Field>

      <Field label="Частота кадров">
        <Select
          ariaLabel="Частота кадров"
          value={isCustom ? customFps : eff.fps}
          options={SCREEN_FPS_OPTIONS}
          labels={(v) => `${v} fps`}
          disabled={!isCustom}
          onChange={(v) => {
            setFps(v as ScreenFps);
            scheduleLive();
          }}
        />
      </Field>

      <Field label="Приоритет">
        <Select
          ariaLabel="Приоритет"
          value={eff.shareMode}
          options={['sharp', 'motion'] as const}
          labels={(v) => SHARE_MODE_LABELS[v]}
          disabled={!isCustom}
          onChange={(v) => {
            setShareMode(v);
            if (publishing) onShareModeChange(v);
            scheduleLive();
          }}
        />
      </Field>

      <Field label="Кодек">
        <Select
          ariaLabel="Кодек"
          value={codec}
          options={['av1', 'vp9'] as const}
          labels={(v) => CODEC_LABELS[v]}
          disabled={publishing}
          onChange={(v) => setCodec(v)}
        />
      </Field>
      {publishing && (
        <p className="text-[11px] text-muted-2">
          Кодек меняется только до начала показа.
        </p>
      )}
    </section>
  );
}

function getPresetShareMode(id: ScreenMode): ShareMode {
  const preset = SCREEN_PRESETS.find((p) => p.id === id);
  return preset?.shareMode ?? 'motion';
}
