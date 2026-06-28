import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router';
import { fetchRoom } from '../api';
import { loadDisplayName, saveDisplayName } from '../utils/storage';
import { CallScreen } from '../components/CallScreen';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export default function RoomPage() {
  const { slug } = useParams();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [name, setName] = useState<string>(() => loadDisplayName());
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (!slug) {
      setState({ kind: 'unavailable' });
      return;
    }
    let cancelled = false;
    fetchRoom(slug)
      .then((room) => {
        if (cancelled) return;
        if (!room || !room.joinable) setState({ kind: 'unavailable' });
        else setState({ kind: 'ready' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const handleJoin = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    saveDisplayName(trimmed);
    setJoined(true);
  }, [name]);

  const handleLeave = useCallback(() => {
    setJoined(false);
  }, []);

  if (joined && slug) {
    return <CallScreen roomSlug={slug} displayName={name.trim()} onLeave={handleLeave} />;
  }

  return (
    <main className="min-h-dvh grid place-items-center bg-bg-0 text-body px-4">
      <div className="w-full max-w-sm">
        {state.kind === 'loading' && (
          <p className="text-center text-muted-2 text-[13px] uppercase tracking-[0.14em]">
            Проверяю комнату…
          </p>
        )}

        {state.kind === 'unavailable' && (
          <div className="card grid gap-3 text-center">
            <h1 className="card-title">Комната недоступна</h1>
            <p className="text-[14px] text-muted">
              Ссылка устарела или звонок уже завершён.
            </p>
            <Link to="/" className="btn btn-secondary justify-center">
              На главную
            </Link>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="card grid gap-3 text-center">
            <h1 className="card-title">Ошибка</h1>
            <p className="text-[14px] text-danger break-words">{state.message}</p>
            <Link to="/" className="btn btn-secondary justify-center">
              На главную
            </Link>
          </div>
        )}

        {state.kind === 'ready' && (
          <div className="card grid gap-4">
            <div>
              <h1 className="card-title">Вход в звонок</h1>
              <p className="mt-1 text-[12px] text-muted-2">Комната {slug}</p>
            </div>
            <label className="grid gap-1">
              <span className="section-label">Ваше имя</span>
              <input
                className="input-field"
                value={name}
                autoFocus
                maxLength={48}
                placeholder="Как вас представить"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleJoin();
                }}
              />
            </label>
            <button
              className="btn btn-primary justify-center"
              disabled={!name.trim()}
              onClick={handleJoin}
            >
              Присоединиться
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
