import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { selectParticipants, selectSelfPeerId, useStore } from '../store/useStore';
import { selectOtherShares, useScreenShareStore } from '../store/useScreenShareStore';
import type { ParticipantUI } from '../types';
import { justifiedLayout, type LayoutInput, type StageTarget } from './tileLayout';
import { AudioChip, CameraTile, ScreenShareTile, SelfScreenTile } from './CallTiles';

const GAP = 12; // px — matches gap-3 used elsewhere

// Callback ref so the observer (re)attaches whenever the measured node mounts —
// the grid area only exists when there's video, so a mount-once effect would
// miss it on an audio-first call that later turns a camera on.
function useElementSize() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const roRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    roRef.current = ro;
    setSize({ w: el.clientWidth, h: el.clientHeight });
  }, []);
  return { ref, size };
}

type VideoTile =
  | { kind: 'screen-self'; id: string }
  | { kind: 'screen'; id: string; hasSystemAudio: boolean }
  | { kind: 'camera'; id: string; participant: ParticipantUI };

export function ParticipantGrid({
  onLocalAudioChange,
  onPin,
}: {
  onLocalAudioChange: () => void;
  onPin: (target: StageTarget) => void;
}) {
  const participants = useStore(selectParticipants);
  const selfId = useStore(selectSelfPeerId);
  const shares = useScreenShareStore((s) => s.shares);
  const myStream = useScreenShareStore((s) => s.myStream);
  const myStatus = useScreenShareStore((s) => s.myStatus);

  const otherShares = useMemo(() => selectOtherShares(shares, selfId), [shares, selfId]);
  const showSelfShare = myStatus === 'publishing' && !!myStream;

  // Video tiles lead (screens first), audio-only participants collapse to chips.
  const { videoTiles, audioParticipants } = useMemo(() => {
    const video: VideoTile[] = [];
    if (showSelfShare && selfId) video.push({ kind: 'screen-self', id: selfId });
    for (const sh of otherShares)
      video.push({ kind: 'screen', id: sh.publisherId, hasSystemAudio: sh.hasSystemAudio });
    const audio: ParticipantUI[] = [];
    for (const p of participants) {
      if (p.cameraOn) video.push({ kind: 'camera', id: p.id, participant: p });
      else audio.push(p);
    }
    return { videoTiles: video, audioParticipants: audio };
  }, [showSelfShare, selfId, otherShares, participants]);

  // Aspect ratios reported by live video elements; layout reflows when they land.
  const aspectsRef = useRef<Map<string, number>>(new Map());
  const [aspectVer, bumpAspects] = useReducer((x: number) => x + 1, 0);
  const reportAspect = useCallback((id: string, ar: number) => {
    const cur = aspectsRef.current.get(id);
    if (cur != null && Math.abs(cur - ar) < 0.01) return;
    aspectsRef.current.set(id, ar);
    bumpAspects();
  }, []);
  // Drop aspects for tiles that are gone so stale ratios don't linger.
  useEffect(() => {
    const ids = new Set(videoTiles.map((t) => t.id));
    for (const key of aspectsRef.current.keys()) if (!ids.has(key)) aspectsRef.current.delete(key);
  }, [videoTiles]);

  const { ref: areaRef, size } = useElementSize();

  const layout = useMemo(() => {
    const items: LayoutInput[] = videoTiles.map((t) => ({
      id: t.id,
      ar: aspectsRef.current.get(t.id) ?? 16 / 9,
    }));
    return justifiedLayout(items, size.w, size.h, GAP, { minH: 96, maxH: size.h });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoTiles, size.w, size.h, aspectVer]);

  const tileById = useMemo(() => new Map(videoTiles.map((t) => [t.id, t])), [videoTiles]);

  const hasVideo = videoTiles.length > 0;

  function renderTile(id: string, w: number, h: number) {
    const t = tileById.get(id);
    if (!t) return null;
    return (
      <div key={id} style={{ width: w, height: h }}>
        {t.kind === 'screen-self' && myStream && (
          <SelfScreenTile
            stream={myStream}
            onPin={() => onPin({ kind: 'screen', id })}
            onAspect={(ar) => reportAspect(id, ar)}
          />
        )}
        {t.kind === 'screen' && (
          <ScreenShareTile
            publisherId={id}
            hasSystemAudio={t.hasSystemAudio}
            onPin={() => onPin({ kind: 'screen', id })}
          />
        )}
        {t.kind === 'camera' && (
          <CameraTile
            participant={t.participant}
            onLocalAudioChange={onLocalAudioChange}
            onPin={() => onPin({ kind: 'camera', id })}
            onAspect={(ar) => reportAspect(id, ar)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {hasVideo ? (
        <div ref={areaRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col items-center gap-3">
            {layout.rows.map((row, i) => (
              <div key={i} className="flex justify-center gap-3" style={{ height: row.h }}>
                {row.tiles.map((tl) => renderTile(tl.id, tl.w, tl.h))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        // Pure audio call — center the avatars instead of a thin strip.
        <div className="flex min-h-0 flex-1 flex-wrap content-center items-center justify-center gap-3 overflow-y-auto">
          {audioParticipants.map((p) => (
            <AudioChip key={p.id} participant={p} size="lg" onLocalAudioChange={onLocalAudioChange} />
          ))}
        </div>
      )}

      {hasVideo && audioParticipants.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-line pt-3">
          {audioParticipants.map((p) => (
            <AudioChip key={p.id} participant={p} onLocalAudioChange={onLocalAudioChange} />
          ))}
        </div>
      )}
    </div>
  );
}
