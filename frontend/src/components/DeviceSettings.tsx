import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useStore } from '../store/useStore';
import { ENGINE_OPTIONS, type ActiveEngineKind } from '../audio/engine';
import type { EngineKind } from '../types';
import { Toggle } from './Toggle';

type Props = {
  onEngineSelect: (engine: EngineKind) => void;
  onMicDeviceSelect: (deviceId: string | null) => void;
  onCamDeviceSelect: (deviceId: string | null) => void;
  onSendVolumeChange: (v: number) => void;
  onOutputVolumeChange: (v: number) => void;
  onReset: () => void;
};

function useDevices(kind: MediaDeviceKind): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) => {
          if (cancelled) return;
          // Drop the synthetic "default"/"communications" aliases (and any
          // empty id) so each real device shows once — matches voice-hub.
          setDevices(
            all.filter(
              (d) =>
                d.kind === kind &&
                d.deviceId &&
                d.deviceId !== 'default' &&
                d.deviceId !== 'communications',
            ),
          );
        })
        .catch(() => {});
    };
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
    };
  }, [kind]);
  return devices;
}

function SliderHead({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center text-[13px] font-bold uppercase tracking-[0.18em]">
      <span className="text-muted">{label}</span>
      <span className="text-accent tabular-nums">{value}</span>
    </div>
  );
}

function Select({
  value,
  ariaLabel,
  onChange,
  children,
}: {
  value: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none w-full pl-3 pr-9 py-2.5 text-[13px]
          bg-bg-input border border-line text-muted cursor-pointer
          hover:border-muted-2 focus:outline-none focus:border-accent transition-colors"
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-2 pointer-events-none"
      />
    </div>
  );
}

export function DeviceSettings({
  onEngineSelect,
  onMicDeviceSelect,
  onCamDeviceSelect,
  onSendVolumeChange,
  onOutputVolumeChange,
  onReset,
}: Props) {
  const engine = useStore((s) => s.engine);
  const sendVolume = useStore((s) => s.sendVolume);
  const outputVolume = useStore((s) => s.outputVolume);
  const micDeviceId = useStore((s) => s.micDeviceId);
  const camDeviceId = useStore((s) => s.camDeviceId);

  // Remember the last denoiser variant so flipping the switch off and on again
  // restores the chosen algorithm instead of resetting to a default.
  const [lastVariant, setLastVariant] = useState<ActiveEngineKind>(
    engine === 'off' ? 'rnnoise' : engine,
  );
  useEffect(() => {
    if (engine !== 'off') setLastVariant(engine);
  }, [engine]);

  const mics = useDevices('audioinput');
  const cams = useDevices('videoinput');

  return (
    <section className="card grid gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="card-title">Звук и устройства</h2>
        <button type="button" onClick={onReset} className="btn btn-secondary btn-mini">
          Сбросить
        </button>
      </div>

      <div className="grid gap-2">
        <SliderHead label="Громкость микрофона" value={`${sendVolume}%`} />
        <input
          type="range"
          className="vh-range"
          min={0}
          max={300}
          step={5}
          value={sendVolume}
          style={{ ['--fill-pct' as string]: `${sendVolume / 3}%` }}
          onChange={(e) => onSendVolumeChange(Number(e.target.value))}
        />
      </div>

      <div className="grid gap-2">
        <SliderHead label="Громкость звука" value={`${outputVolume}%`} />
        <input
          type="range"
          className="vh-range"
          min={0}
          max={300}
          step={5}
          value={outputVolume}
          style={{ ['--fill-pct' as string]: `${outputVolume / 3}%` }}
          onChange={(e) => onOutputVolumeChange(Number(e.target.value))}
        />
      </div>

      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="section-label">Шумоподавление</span>
          <Toggle
            checked={engine !== 'off'}
            onChange={() => onEngineSelect(engine === 'off' ? lastVariant : 'off')}
            ariaLabel="Шумоподавление"
          />
        </div>
        {engine !== 'off' && (
          <div className="border-l border-line pl-4 ml-1">
            <Select
              value={engine}
              ariaLabel="Алгоритм шумоподавления"
              onChange={(v) => onEngineSelect(v as ActiveEngineKind)}
            >
              {ENGINE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      <label className="grid gap-1.5">
        <span className="section-label">Микрофон</span>
        <Select
          value={micDeviceId ?? ''}
          ariaLabel="Микрофон"
          onChange={(v) => onMicDeviceSelect(v || null)}
        >
          <option value="">Системный по умолчанию</option>
          {mics.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Микрофон ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </Select>
      </label>

      <label className="grid gap-1.5">
        <span className="section-label">Камера</span>
        <Select
          value={camDeviceId ?? ''}
          ariaLabel="Камера"
          onChange={(v) => onCamDeviceSelect(v || null)}
        >
          <option value="">Системная по умолчанию</option>
          {cams.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Камера ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </Select>
      </label>
    </section>
  );
}
