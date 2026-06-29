import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Check, Copy, LogOut, Pencil, Settings, Share2, X } from 'lucide-react';
import {
  copyRoom,
  createRoom,
  fetchMe,
  fetchRoom,
  listJoinedRooms,
  listMyRooms,
  login,
  logout,
  register,
  renameRoom,
  shareRoom,
  type RoomCreated,
  type RoomSummary,
  type User,
} from '../api';
import {
  listRecentRooms,
  removeRecentRoom,
  type RecentRoom,
} from '../utils/storage';
import { errText, fmtDateTime } from './accountShared';

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('invite');

  const [me, setMe] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Login is tucked behind a corner button — a guest's primary content is their
  // recent rooms, not the sign-in form.
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) {
    return (
      <main className="min-h-dvh grid place-items-center bg-bg-0 text-muted-2">
        <span className="text-[13px] uppercase tracking-[0.14em]">Загрузка…</span>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center bg-bg-0 text-body px-4 py-10">
      {me && <AccountControls onLogout={() => setMe(null)} />}
      {!me && !inviteToken && !showLogin && (
        <button
          className="absolute right-4 top-4 btn btn-secondary btn-mini"
          onClick={() => setShowLogin(true)}
        >
          Войти
        </button>
      )}
      <div className="w-full max-w-md grid gap-6">
        <header className="text-center">
          <h1 className="text-2xl font-extrabold uppercase tracking-[0.2em] text-accent">
            Sozvon
          </h1>
        </header>

        {me ? (
          <RoomsCard />
        ) : inviteToken ? (
          <RegisterForm inviteToken={inviteToken} onAuthed={setMe} />
        ) : showLogin ? (
          <div className="grid gap-3">
            <LoginForm onAuthed={setMe} />
            <button
              type="button"
              onClick={() => setShowLogin(false)}
              className="text-center text-[12px] text-muted-2 transition-colors hover:text-muted"
            >
              Назад
            </button>
          </div>
        ) : (
          <RecentRoomsCard />
        )}
      </div>
    </main>
  );
}

function AccountControls({ onLogout }: { onLogout: () => void }) {
  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      /* ignore */
    }
    onLogout();
  }, [onLogout]);

  return (
    <div className="absolute right-4 top-4 flex items-center gap-2">
      <Link
        to="/settings"
        className="btn btn-secondary btn-mini"
        title="Настройки"
        aria-label="Настройки"
      >
        <Settings size={15} />
      </Link>
      <button
        className="btn btn-secondary btn-mini"
        onClick={handleLogout}
        title="Выйти"
        aria-label="Выйти"
      >
        <LogOut size={15} />
      </button>
    </div>
  );
}

function LoginForm({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        onAuthed(await login(username.trim(), password));
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    },
    [username, password, busy, onAuthed],
  );

  return (
    <form className="card grid gap-4" onSubmit={submit}>
      <h2 className="card-title">Вход</h2>
      <label className="grid gap-1">
        <span className="section-label">Логин</span>
        <input
          className="input-field"
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="grid gap-1">
        <span className="section-label">Пароль</span>
        <input
          className="input-field"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      <button className="btn btn-primary justify-center" disabled={busy || !username.trim() || !password}>
        {busy ? 'Вхожу…' : 'Войти'}
      </button>
      <p className="text-[12px] text-muted-2 text-center">
        Регистрация только по приглашению.
      </p>
    </form>
  );
}

// Rooms opened on this device, shown to guests so they can rejoin a call
// without an account. Logged-in users get a server-backed list instead.
function RecentRoomsCard() {
  const [recent, setRecent] = useState<RecentRoom[]>(() => listRecentRooms());

  // Prune rooms that have ended or expired so dead links don't linger. A
  // transient network error keeps the entry (we only drop confirmed-dead ones).
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      listRecentRooms().map(async (r) => {
        try {
          const room = await fetchRoom(r.slug);
          return room && room.joinable ? null : r.slug; // dead → slug to drop
        } catch {
          return null; // keep on transient failure
        }
      }),
    ).then((toDrop) => {
      if (cancelled) return;
      const dead = toDrop.filter((s): s is string => s !== null);
      if (dead.length === 0) return;
      dead.forEach((slug) => removeRecentRoom(slug));
      setRecent(listRecentRooms());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const forget = useCallback((slug: string) => {
    removeRecentRoom(slug);
    setRecent(listRecentRooms());
  }, []);

  return (
    <section className="card grid gap-3">
      <h2 className="card-title">Комнаты</h2>
      {recent.length === 0 && (
        <p className="text-[13px] text-muted-2">
          Пока пусто. Откройте ссылку на звонок, чтобы присоединиться.
        </p>
      )}
      {recent.length > 0 && (
      <ul className="grid gap-2">
        {recent.map((r) => (
          <li
            key={r.slug}
            className="flex min-w-0 items-center justify-between gap-3 border border-line bg-bg-input px-3 py-2"
          >
            <a
              href={`/r/${r.slug}`}
              className="min-w-0 truncate text-[13px] text-accent underline underline-offset-2"
            >
              {r.name || r.slug}
            </a>
            <button
              className="btn btn-secondary btn-mini shrink-0"
              onClick={() => forget(r.slug)}
              title="Убрать из списка"
              aria-label="Убрать из списка"
            >
              <X size={15} />
            </button>
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}

function RegisterForm({
  inviteToken,
  onAuthed,
}: {
  inviteToken: string;
  onAuthed: (u: User) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        onAuthed(await register(inviteToken, username.trim(), password));
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusy(false);
      }
    },
    [inviteToken, username, password, busy, onAuthed],
  );

  return (
    <form className="card grid gap-4" onSubmit={submit}>
      <h2 className="card-title">Регистрация</h2>
      <p className="text-[12px] text-muted-2">Вы приглашены создать аккаунт.</p>
      <label className="grid gap-1">
        <span className="section-label">Логин</span>
        <input
          className="input-field"
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="grid gap-1">
        <span className="section-label">Пароль</span>
        <input
          className="input-field"
          type="password"
          value={password}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      <button
        className="btn btn-primary justify-center"
        disabled={busy || !username.trim() || password.length < 8}
      >
        {busy ? 'Создаю…' : 'Создать аккаунт'}
      </button>
    </form>
  );
}

function RoomsCard() {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [joined, setJoined] = useState<RoomSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<RoomCreated | null>(null);
  const [newName, setNewName] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    listMyRooms()
      .then(setRooms)
      .catch(() => {});
    listJoinedRooms()
      .then(setJoined)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  useEffect(refresh, [refresh]);

  // Tick the relative labels and re-poll so participant counts / close timers
  // stay current without a manual reload.
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      refresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const create = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setFresh(await createRoom(newName));
      setNewName('');
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, newName]);

  const onRenamed = useCallback((slug: string, name: string) => {
    setRooms((prev) => prev.map((r) => (r.slug === slug ? { ...r, name } : r)));
  }, []);

  return (
    <section className="card grid gap-3">
      <h2 className="card-title">Комнаты</h2>

      <div className="grid gap-2">
        <input
          className="input-field mt-0"
          value={newName}
          maxLength={64}
          placeholder="Название (необязательно)"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
        />
        <button className="btn btn-primary justify-center" onClick={create} disabled={busy}>
          {busy ? 'Создаю…' : 'Создать комнату'}
        </button>
      </div>
      {error && <p className="text-[13px] text-danger">{error}</p>}

      {fresh && (
        <div className="grid gap-2 border border-accent/40 bg-bg-input p-3">
          <span className="section-label min-w-0 break-words">Новая комната «{fresh.name}»</span>
          <div className="flex gap-2">
            <input
              className="input-field mt-0 min-w-0 flex-1"
              readOnly
              value={`${window.location.origin}${fresh.url}`}
              onFocus={(e) => e.target.select()}
            />
            <RoomShareButtons slug={fresh.slug} />
          </div>
          {fresh.expiresAt && (
            <p className="text-[12px] text-muted-2">
              Действует до {fmtDateTime(fresh.expiresAt)}, пока никто не зашёл.
            </p>
          )}
        </div>
      )}

      {loaded && rooms.length === 0 && joined.length === 0 && (
        <p className="text-[13px] text-muted-2">Активных комнат нет.</p>
      )}

      {rooms.length > 0 && (
        <div className="grid gap-2">
          <span className="section-label">Мои комнаты</span>
          <ul className="grid gap-2">
            {rooms.map((r) => (
              <CreatedRoomRow key={r.slug} room={r} now={now} onRenamed={onRenamed} />
            ))}
          </ul>
        </div>
      )}

      {joined.length > 0 && (
        <div className="grid gap-2">
          <span className="section-label">Куда заходил</span>
          <ul className="grid gap-2">
            {joined.map((r) => (
              <JoinedRoomRow key={r.slug} room={r} now={now} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// Status/expiry tail shown after a room's name, e.g. " · ожидает · истекает через 2 ч".
function RoomStatusTail({ room, now }: { room: RoomSummary; now: number }) {
  if (room.status === 'active') {
    if (room.participants > 0) {
      return <span className="text-muted-2"> · идёт · {room.participants} в звонке</span>;
    }
    // Active but empty: the grace teardown is counting down.
    const tail = closeTail(room.closesAt, now);
    return <span className="text-muted-2"> · никого{tail ? ` · ${tail}` : ''}</span>;
  }
  const tail = expiryTail(room.expiresAt, now);
  return <span className="text-muted-2"> · ожидает{tail ? ` · ${tail}` : ''}</span>;
}

type RoomRowProps = {
  room: RoomSummary;
  now: number;
};

// "Скопировать" + "Поделиться" pair shown next to a room link. Each instance
// owns its own 2 s confirmation tick, so buttons never interfere.
function RoomShareButtons({ slug }: { slug: string }) {
  const [done, setDone] = useState<'copy' | 'share' | null>(null);

  const flash = (action: 'copy' | 'share') => {
    setDone(action);
    setTimeout(() => setDone(null), 2000);
  };

  const copy = async () => {
    if (await copyRoom(slug)) flash('copy');
  };
  const share = async () => {
    // On desktop shareRoom copies; on mobile the native sheet gives its own
    // feedback, but the tick is harmless either way.
    if ((await shareRoom(slug)) !== 'fail') flash('share');
  };

  return (
    <>
      <button
        className="btn btn-secondary btn-mini shrink-0"
        onClick={copy}
        title="Скопировать ссылку"
        aria-label="Скопировать ссылку"
      >
        {done === 'copy' ? <Check size={15} /> : <Copy size={15} />}
      </button>
      <button
        className="btn btn-secondary btn-mini shrink-0"
        onClick={share}
        title="Поделиться ссылкой"
        aria-label="Поделиться ссылкой"
      >
        {done === 'share' ? <Check size={15} /> : <Share2 size={15} />}
      </button>
    </>
  );
}

// A room the caller created: name is renamable, plus share.
function CreatedRoomRow({
  room,
  now,
  onRenamed,
}: RoomRowProps & { onRenamed: (slug: string, name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.name);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    const name = draft.trim();
    if (saving || !name) return;
    setSaving(true);
    try {
      await renameRoom(room.slug, name);
      onRenamed(room.slug, name);
      setEditing(false);
    } catch {
      /* leave the editor open so the user can retry */
    } finally {
      setSaving(false);
    }
  }, [draft, saving, room.slug, onRenamed]);

  const cancel = useCallback(() => {
    setDraft(room.name);
    setEditing(false);
  }, [room.name]);

  if (editing) {
    return (
      <li className="flex min-w-0 items-center gap-2 border border-line bg-bg-input px-3 py-2">
        <input
          className="input-field mt-0 min-w-0 flex-1"
          value={draft}
          maxLength={64}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') cancel();
          }}
        />
        <button
          className="btn btn-secondary btn-mini shrink-0"
          onClick={save}
          disabled={saving || !draft.trim()}
          aria-label="Сохранить имя"
        >
          <Check size={15} />
        </button>
        <button
          className="btn btn-secondary btn-mini shrink-0"
          onClick={cancel}
          aria-label="Отмена"
        >
          <X size={15} />
        </button>
      </li>
    );
  }

  return (
    <li className="flex min-w-0 items-center justify-between gap-3 border border-line bg-bg-input px-3 py-2">
      <span className="min-w-0 truncate text-[13px] text-muted">
        <a href={room.url} className="text-accent underline underline-offset-2">
          {room.name || room.slug}
        </a>
        <RoomStatusTail room={room} now={now} />
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          className="btn btn-secondary btn-mini"
          onClick={() => {
            setDraft(room.name);
            setEditing(true);
          }}
          title="Переименовать"
          aria-label="Переименовать"
        >
          <Pencil size={15} />
        </button>
        <RoomShareButtons slug={room.slug} />
      </div>
    </li>
  );
}

// A room the caller joined but does not own: read-only name, plus share.
function JoinedRoomRow({ room, now }: RoomRowProps) {
  return (
    <li className="flex min-w-0 items-center justify-between gap-3 border border-line bg-bg-input px-3 py-2">
      <span className="min-w-0 truncate text-[13px] text-muted">
        <a href={room.url} className="text-accent underline underline-offset-2">
          {room.name || room.slug}
        </a>
        <RoomStatusTail room={room} now={now} />
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <RoomShareButtons slug={room.slug} />
      </div>
    </li>
  );
}

// "{verb} через 4 мин" / "{verb} через 23 ч 10 мин" for a positive minute count.
function durationTail(min: number, verb: string): string {
  if (min < 60) return `${verb} через ${min} мин`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${verb} через ${h} ч ${rem} мин` : `${verb} через ${h} ч`;
}

// Relative time left until a pending link expires, e.g. "истекает через 23 ч".
// Returns '' when there's nothing meaningful to show (no/invalid date).
function expiryTail(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const ms = t - now;
  if (ms <= 60_000) return 'истекает';
  return durationTail(Math.round(ms / 60_000), 'истекает');
}

// Time left until an empty room auto-closes after the grace period, e.g.
// "закроется через 4 мин". Returns '' when there's no pending close.
function closeTail(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.round((t - now) / 60_000);
  if (min < 1) return 'закрывается';
  return durationTail(min, 'закроется');
}
