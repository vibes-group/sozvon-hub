import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ApiError,
  createInvite,
  createRoom,
  fetchMe,
  listInvites,
  login,
  logout,
  register,
  revokeInvite,
  type Invite,
  type RoomCreated,
  type User,
} from '../api';

const ERROR_RU: Record<string, string> = {
  invalid_credentials: 'Неверное имя пользователя или пароль.',
  invalid_username: 'Недопустимое имя пользователя.',
  invalid_password: 'Пароль должен быть не короче 8 символов.',
  username_taken: 'Это имя пользователя уже занято.',
  invalid_invite: 'Приглашение недействительно или истекло.',
  invite_required: 'Нужно действительное приглашение.',
  invite_used: 'Приглашение уже использовано.',
};

function errText(err: unknown): string {
  if (err instanceof ApiError) return ERROR_RU[err.code] ?? `Ошибка: ${err.code}`;
  return err instanceof Error ? err.message : 'Неизвестная ошибка';
}

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('invite');

  const [me, setMe] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);

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
    <main className="min-h-dvh bg-bg-0 text-body px-4 py-10 grid place-items-center">
      <div className="w-full max-w-md grid gap-6">
        <header className="text-center grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text">sozvon-hub</h1>
          <p className="text-[13px] text-muted-2">Быстрые видеозвонки по ссылке</p>
        </header>

        {me ? (
          <Dashboard user={me} onLogout={() => setMe(null)} />
        ) : inviteToken ? (
          <RegisterForm inviteToken={inviteToken} onAuthed={setMe} />
        ) : (
          <LoginForm onAuthed={setMe} />
        )}
      </div>
    </main>
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
        <span className="section-label">Имя пользователя</span>
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
        <span className="section-label">Имя пользователя</span>
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

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [room, setRoom] = useState<RoomCreated | null>(null);
  const [roomBusy, setRoomBusy] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const roomLink = room ? `${window.location.origin}${room.url}` : '';

  const handleCreateRoom = useCallback(async () => {
    if (roomBusy) return;
    setRoomBusy(true);
    setRoomError(null);
    setCopied(false);
    try {
      setRoom(await createRoom());
    } catch (err) {
      setRoomError(errText(err));
    } finally {
      setRoomBusy(false);
    }
  }, [roomBusy]);

  const copyLink = useCallback(async () => {
    if (!roomLink) return;
    try {
      await navigator.clipboard.writeText(roomLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [roomLink]);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      /* ignore */
    }
    onLogout();
  }, [onLogout]);

  return (
    <div className="grid gap-4">
      <section className="card grid gap-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-muted">
            Вы вошли как <span className="text-text font-medium">{user.username}</span>
          </span>
          <button className="btn btn-secondary btn-mini" onClick={handleLogout}>
            Выйти
          </button>
        </div>

        <button className="btn btn-primary justify-center" onClick={handleCreateRoom} disabled={roomBusy}>
          {roomBusy ? 'Создаю…' : 'Создать комнату'}
        </button>
        {roomError && <p className="text-[13px] text-danger">{roomError}</p>}

        {room && (
          <div className="grid gap-2 border border-line bg-bg-input p-3">
            <span className="section-label">Ссылка на комнату</span>
            <div className="flex gap-2">
              <input className="input-field mt-0 flex-1" readOnly value={roomLink} onFocus={(e) => e.target.select()} />
              <button className="btn btn-secondary shrink-0" onClick={copyLink}>
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
            </div>
            <a className="text-[13px] text-accent underline underline-offset-2" href={room.url}>
              Открыть комнату
            </a>
          </div>
        )}
      </section>

      <InvitesCard />
    </div>
  );
}

function InvitesCard() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<Invite | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listInvites()
      .then(setInvites)
      .catch((err) => setError(errText(err)))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(refresh, [refresh]);

  const handleCreate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const inv = await createInvite();
      setFreshToken(inv);
      refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const handleRevoke = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await revokeInvite(id);
        refresh();
      } catch (err) {
        setError(errText(err));
      }
    },
    [refresh],
  );

  const copyInvite = useCallback(async (inv: Invite) => {
    const url = inv.url ?? '';
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(inv.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <section className="card grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="card-title">Приглашения</h2>
        <button className="btn btn-secondary btn-mini" onClick={handleCreate} disabled={busy}>
          {busy ? '…' : 'Создать'}
        </button>
      </div>

      {error && <p className="text-[13px] text-danger">{error}</p>}

      {freshToken?.url && (
        <div className="grid gap-2 border border-accent/40 bg-bg-input p-3">
          <span className="section-label">Новая ссылка-приглашение</span>
          <div className="flex gap-2">
            <input
              className="input-field mt-0 flex-1"
              readOnly
              value={freshToken.url}
              onFocus={(e) => e.target.select()}
            />
            <button className="btn btn-secondary shrink-0" onClick={() => copyInvite(freshToken)}>
              {copiedId === freshToken.id ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
          <p className="text-[12px] text-muted-2">Ссылка показывается один раз — сохраните её.</p>
        </div>
      )}

      {loaded && invites.length === 0 && (
        <p className="text-[13px] text-muted-2">Активных приглашений нет.</p>
      )}

      {invites.length > 0 && (
        <ul className="grid gap-2">
          {invites.map((inv) => (
            <li
              key={inv.id}
              className="flex items-center justify-between gap-3 border border-line bg-bg-input px-3 py-2"
            >
              <span className="text-[13px] text-muted truncate">
                {inv.usedAt ? 'Использовано' : 'Действует'}
                {inv.expiresAt && (
                  <span className="text-muted-2"> · до {new Date(inv.expiresAt).toLocaleDateString('ru-RU')}</span>
                )}
              </span>
              <button
                className="btn btn-danger btn-mini shrink-0"
                onClick={() => handleRevoke(inv.id)}
              >
                Отозвать
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
