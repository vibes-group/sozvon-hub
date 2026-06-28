import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { ENGINE_OPTIONS } from '../audio/engine';
import type { EngineKind } from '../types';

type Props = {
  onEngineSelect: (engine: EngineKind) => void;
  onMicDeviceSelect: (deviceId: string | null) => void;
  onOutputVolumeChange: (v: number) => void;
};

function useDevices(kind: MediaDeviceKind): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) => {
          if (!cancelled) setDevices(all.filter((d) => d.kind === kind));
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

export function DeviceSettings({ onEngineSelect, onMicDeviceSelect, onOutputVolumeChange }: Props) {
  const engine = useStore((s) => s.engine);
  const micDeviceId = useStore((s) => s.micDeviceId);
  const camDeviceId = useStore((s) => s.camDeviceId);
  const setCamDeviceId = useStore((s) => s.setCamDeviceId);
  const outputVolume = useStore((s) => s.outputVolume);

  const mics = useDevices('audioinput');
  const cams = useDevices('videoinput');

  return (
    <section className="card grid gap-4">
      <h2 className="card-title">Настройки</h2>

      <label className="grid gap-1">
        <span className="section-label">Микрофон</span>
        <select
          className="input-field"
          value={micDeviceId ?? ''}
          onChange={(e) => onMicDeviceSelect(e.target.value || null)}
        >
          <option value="">Системный по умолчанию</option>
          {mics.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Микрофон ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1">
        <span className="section-label">Камера</span>
        <select
          className="input-field"
          value={camDeviceId ?? ''}
          onChange={(e) => setCamDeviceId(e.target.value || null)}
        >
          <option value="">Системная по умолчанию</option>
          {cams.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Камера ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1">
        <span className="section-label">Шумоподавление</span>
        <select
          className="input-field"
          value={engine}
          onChange={(e) => onEngineSelect(e.target.value as EngineKind)}
        >
          <option value="off">Выкл.</option>
          {ENGINE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1.5">
        <span className="section-label">Громкость · {outputVolume}%</span>
        <input
          type="range"
          className="vh-range"
          min={0}
          max={200}
          step={1}
          value={outputVolume}
          style={{ ['--fill-pct' as string]: `${(outputVolume / 200) * 100}%` }}
          onChange={(e) => onOutputVolumeChange(Number(e.target.value))}
        />
      </label>
    </section>
  );
}
