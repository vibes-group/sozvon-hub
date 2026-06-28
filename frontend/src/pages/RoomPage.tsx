import { useCallback, useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router';
import { fetchRoom, fetchMe, updateAccount, type User } from '../api';
import { loadDisplayName, saveDisplayName } from '../utils/storage';
import { CallScreen } from '../components/CallScreen';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export default function RoomPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [name, setName] = useState<string>(() => loadDisplayName());
  const [account, setAccount] = useState<User | null>(null);
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

  // Logged-in users: the account display name is the source of truth — prefill
  // it over the localStorage value. Guests keep the localStorage name.
  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((u) => {
        if (cancelled || !u) return;
        setAccount(u);
        if (u.name) setName(u.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleJoin = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Always cache locally (covers guests); persist to the account when changed.
    saveDisplayName(trimmed);
    if (account && trimmed !== account.name) {
      void updateAccount({ name: trimmed }).catch(() => {});
    }
    setJoined(true);
  }, [name, account]);

  const handleLeave = useCallback(() => {
    navigate('/');
  }, [navigate]);

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
            <p className="text-[14px] text-muted">Ссылка устарела или звонок уже завершён.</p>
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
            <Link
              to="/"
              className="text-center text-[12px] text-muted-2 transition-colors hover:text-muted"
            >
              На главную
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
