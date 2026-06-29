import { useCallback, useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router';
import { fetchRoom, fetchMe, updateAccount, type User } from '../api';
import {
  loadDisplayName,
  saveDisplayName,
  makeGuestName,
  markRoomJoined,
  wasRoomJoined,
  clearRoomJoined,
} from '../utils/storage';
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
  // Generated once so it stays put across keystrokes; shown as the placeholder
  // and used verbatim if the field is left blank — what you see is what you get.
  const [guestName] = useState(makeGuestName);
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

  // Reloaded mid-call: the tab still remembers we joined this room, so skip the
  // name prompt and re-join once the room is confirmed available. Gating on
  // `ready` means a call that ended meanwhile shows "Комната недоступна"
  // instead of a CallScreen that can't connect.
  useEffect(() => {
    if (state.kind === 'ready' && slug && !joined && wasRoomJoined(slug)) {
      setJoined(true);
    }
  }, [state, slug, joined]);

  const handleJoin = useCallback(() => {
    // Name is optional: a blank entry uses the placeholder guest name.
    const finalName = name.trim() || guestName;
    // Always cache locally (covers guests); persist to the account when changed.
    saveDisplayName(finalName);
    if (account && finalName !== account.name) {
      void updateAccount({ name: finalName }).catch(() => {});
    }
    if (finalName !== name) setName(finalName);
    if (slug) markRoomJoined(slug);
    setJoined(true);
  }, [name, guestName, account, slug]);

  const handleLeave = useCallback(() => {
    if (slug) clearRoomJoined(slug);
    navigate('/');
  }, [navigate, slug]);

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
                className="input-field text-accent font-medium"
                value={name}
                autoFocus
                maxLength={48}
                placeholder={guestName}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleJoin();
                }}
              />
            </label>
            <p className="-mt-2 text-[12px] text-muted-2">
              Можно не вводить — будете «{guestName}»
            </p>
            <button className="btn btn-primary justify-center" onClick={handleJoin}>
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
