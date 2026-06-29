import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Check, Share2 } from 'lucide-react';
import {
  adminListUsers,
  adminUpdateUser,
  ApiError,
  changePassword,
  createInvite,
  createRoom,
  fetchMe,
  listInvites,
  listMyRooms,
  login,
  logout,
  register,
  revokeInvite,
  shareRoom,
  updateAccount,
  type AdminUserView,
  type Invite,
  type RoomCreated,
  type RoomSummary,
  type User,
} from '../api';

const ERROR_RU: Record<string, string> = {
  invalid_credentials: 'Неверный логин или пароль.',
  invalid_username: 'Недопустимый логин.',
  invalid_name: 'Недопустимое имя.',
  invalid_password: 'Пароль должен быть не короче 8 символов.',
  username_taken: 'Этот логин уже занят.',
  invalid_invite: 'Приглашение недействительно или истекло.',
  invite_required: 'Нужно действительное приглашение.',
  invite_used: 'Приглашение уже использовано.',
};

function errText(err: unknown): string {
  if (err instanceof ApiError) return ERROR_RU[err.code] ?? `Ошибка: ${err.code}`;
  return err instanceof Error ? err.message : 'Неизвестная ошибка';
}

function absUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return `${window.location.origin}${path}`;
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
        <header className="text-center grid gap-1.5">
          <h1 className="text-2xl font-extrabold uppercase tracking-[0.2em] text-accent">
            Sozvon&nbsp;Hub
          </h1>
          <p className="text-[13px] text-muted-2">Быстрые видеозвонки по ссылке</p>
        </header>

        {me ? (
          <Dashboard user={me} onLogout={() => setMe(null)} onUserUpdate={setMe} />
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

function Dashboard({
  user,
  onLogout,
  onUserUpdate,
}: {
  user: User;
  onLogout: () => void;
  onUserUpdate: (u: User) => void;
}) {
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
      <div className="flex items-center justify-between gap-3 px-1">
        <span className="text-[13px] text-muted">
          Вы вошли как <span className="font-medium text-text">{user.username}</span>
        </span>
        <button className="btn btn-secondary btn-mini" onClick={handleLogout}>
          Выйти
        </button>
      </div>

      <RoomsCard />
      <ProfileCard user={user} onUpdated={onUserUpdate} />
      {(user.canInvite || user.isAdmin) && <InvitesCard isAdmin={user.isAdmin} />}
      {user.isAdmin && <AdminUsersCard />}
    </div>
  );
}

function RoomsCard() {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<RoomCreated | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => {
    listMyRooms()
      .then(setRooms)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  useEffect(refresh, [refresh]);

  // Keep the relative "истекает через …" labels fresh without a reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const create = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setFresh(await createRoom());
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const share = useCallback(async (key: string, slug: string) => {
    const result = await shareRoom(slug);
    if (result === 'fail') return;
    // On desktop this means "copied"; on mobile the native sheet already gave
    // its own feedback, but the tick is harmless either way.
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  return (
    <section className="card grid gap-3">
      <h2 className="card-title">Комнаты</h2>

      <button className="btn btn-primary justify-center" onClick={create} disabled={busy}>
        {busy ? 'Создаю…' : 'Создать комнату'}
      </button>
      {error && <p className="text-[13px] text-danger">{error}</p>}

      {fresh && (
        <div className="grid gap-2 border border-accent/40 bg-bg-input p-3">
          <span className="section-label">Новая ссылка</span>
          <div className="flex gap-2">
            <input
              className="input-field mt-0 flex-1"
              readOnly
              value={`${window.location.origin}${fresh.url}`}
              onFocus={(e) => e.target.select()}
            />
            <button className="btn btn-secondary shrink-0" onClick={() => share('fresh', fresh.slug)}>
              {copied === 'fresh' ? 'Скопировано' : 'Поделиться'}
            </button>
          </div>
          {fresh.expiresAt && (
            <p className="text-[12px] text-muted-2">
              Действует до {fmtDateTime(fresh.expiresAt)}, пока никто не зашёл.
            </p>
          )}
        </div>
      )}

      {loaded && rooms.length === 0 && <p className="text-[13px] text-muted-2">Активных комнат нет.</p>}
      {rooms.length > 0 && (
        <ul className="grid gap-2">
          {rooms.map((r) => (
            <li
              key={r.slug}
              className="flex items-center justify-between gap-3 border border-line bg-bg-input px-3 py-2"
            >
              <span className="min-w-0 truncate text-[13px] text-muted">
                <a href={r.url} className="text-accent underline underline-offset-2">
                  {r.slug}
                </a>
                {(() => {
                  if (r.status === 'active') return <span className="text-muted-2"> · идёт</span>;
                  const tail = expiryTail(r.expiresAt, now);
                  return <span className="text-muted-2"> · ожидает{tail ? ` · ${tail}` : ''}</span>;
                })()}
              </span>
              <button
                className="btn btn-secondary btn-mini shrink-0"
                onClick={() => share(r.slug, r.slug)}
                title="Поделиться ссылкой"
                aria-label="Поделиться ссылкой"
              >
                {copied === r.slug ? <Check size={15} /> : <Share2 size={15} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function fmtDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

// Relative time left until a pending link expires, e.g. "истекает через 23 ч".
// Returns '' when there's nothing meaningful to show (no/invalid date).
function expiryTail(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const ms = t - now;
  if (ms <= 60_000) return 'истекает';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `истекает через ${min} мин`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `истекает через ${h} ч ${rem} мин` : `истекает через ${h} ч`;
}

function AdminUsersCard() {
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    adminListUsers()
      .then(setUsers)
      .catch((e) => setError(errText(e)))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(refresh, [refresh]);

  const patch = useCallback((id: string, p: Partial<AdminUserView>) => {
    setUsers((prev) => prev.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }, []);

  return (
    <section className="card grid gap-3">
      <h2 className="card-title">Пользователи</h2>
      <p className="card-hint">Никнейм виден только вам</p>
      {error && <p className="text-[13px] text-danger">{error}</p>}
      {loaded && users.length === 0 && <p className="text-[13px] text-muted-2">Нет пользователей.</p>}
      {users.length > 0 && (
        <ul className="grid gap-2">
          {users.map((u) => (
            <AdminUserRow key={u.id} user={u} onPatch={patch} onError={setError} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AdminUserRow({
  user: u,
  onPatch,
  onError,
}: {
  user: AdminUserView;
  onPatch: (id: string, p: Partial<AdminUserView>) => void;
  onError: (msg: string | null) => void;
}) {
  const [note, setNote] = useState(u.adminNote);
  const [busy, setBusy] = useState<null | 'note' | 'invite'>(null);

  const saveNote = useCallback(async () => {
    if (busy || note.trim() === u.adminNote) return;
    setBusy('note');
    onError(null);
    try {
      await adminUpdateUser(u.id, { adminNote: note.trim() });
      onPatch(u.id, { adminNote: note.trim() });
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy(null);
    }
  }, [busy, note, u.adminNote, u.id, onPatch, onError]);

  const toggleInvite = useCallback(async () => {
    if (busy) return;
    setBusy('invite');
    onError(null);
    try {
      await adminUpdateUser(u.id, { canInvite: !u.canInvite });
      onPatch(u.id, { canInvite: !u.canInvite });
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy(null);
    }
  }, [busy, u.canInvite, u.id, onPatch, onError]);

  return (
    <li className="grid gap-2 border border-line bg-bg-input px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[13px]">
          <span className="font-medium text-text">{u.username}</span>
          {u.isAdmin && <span className="text-accent"> · админ</span>}
        </span>
        {u.isAdmin ? (
          <span className="shrink-0 text-[12px] text-muted-2">приглашает всегда</span>
        ) : (
          <button
            className={`btn btn-mini shrink-0 ${u.canInvite ? 'btn-primary' : 'btn-secondary'}`}
            disabled={busy === 'invite'}
            onClick={toggleInvite}
          >
            {u.canInvite ? 'Может приглашать' : 'Не может'}
          </button>
        )}
      </div>
      <div className="text-[11px] text-muted-2">
        Имя: <span className="text-muted">{u.name || '—'}</span> · рег: {fmtDateTime(u.createdAt)} · вход:{' '}
        {fmtDateTime(u.lastSeenAt)}
      </div>
      <div className="flex gap-2">
        <input
          className="input-field mt-0 flex-1"
          value={note}
          maxLength={100}
          placeholder="Никнейм (только для вас)"
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          className="btn btn-secondary btn-mini shrink-0"
          disabled={busy === 'note' || note.trim() === u.adminNote}
          onClick={saveNote}
        >
          {busy === 'note' ? '…' : 'Сохранить'}
        </button>
      </div>
    </li>
  );
}

function ProfileCard({ user, onUpdated }: { user: User; onUpdated: (u: User) => void }) {
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username);
  const [busy, setBusy] = useState<null | 'name' | 'username' | 'password'>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');

  const savePassword = useCallback(async () => {
    if (busy) return;
    setBusy('password');
    setMsg(null);
    try {
      await changePassword(curPw, newPw);
      setCurPw('');
      setNewPw('');
      setMsg({ text: 'Пароль обновлён.', ok: true });
    } catch (err) {
      setMsg({ text: errText(err), ok: false });
    } finally {
      setBusy(null);
    }
  }, [busy, curPw, newPw]);

  const save = useCallback(
    async (patch: { name?: string; username?: string }, which: 'name' | 'username', okText: string) => {
      if (busy) return;
      setBusy(which);
      setMsg(null);
      try {
        const updated = await updateAccount(patch);
        onUpdated(updated);
        setName(updated.name);
        setUsername(updated.username);
        setMsg({ text: okText, ok: true });
      } catch (err) {
        setMsg({ text: errText(err), ok: false });
      } finally {
        setBusy(null);
      }
    },
    [busy, onUpdated],
  );

  const nameChanged = name.trim() !== '' && name.trim() !== user.name;
  const usernameChanged = username.trim() !== '' && username.trim() !== user.username;

  return (
    <section className="card grid gap-4">
      <h2 className="card-title">Профиль</h2>
      <label className="grid gap-1">
        <span className="section-label">Имя для звонков</span>
        <div className="flex gap-2">
          <input
            className="input-field mt-0 flex-1"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn btn-secondary shrink-0"
            disabled={!nameChanged || busy === 'name'}
            onClick={() => save({ name: name.trim() }, 'name', 'Имя обновлено.')}
          >
            {busy === 'name' ? '…' : 'Сохранить'}
          </button>
        </div>
      </label>
      <label className="grid gap-1">
        <span className="section-label">Логин</span>
        <div className="flex gap-2">
          <input
            className="input-field mt-0 flex-1"
            value={username}
            maxLength={64}
            autoComplete="off"
            onChange={(e) => setUsername(e.target.value)}
          />
          <button
            className="btn btn-secondary shrink-0"
            disabled={!usernameChanged || busy === 'username'}
            onClick={() => save({ username: username.trim() }, 'username', 'Логин обновлён.')}
          >
            {busy === 'username' ? '…' : 'Сохранить'}
          </button>
        </div>
      </label>

      <div className="grid gap-2 border-t border-line pt-4">
        <span className="section-label">Сменить пароль</span>
        <input
          className="input-field mt-0"
          type="password"
          value={curPw}
          autoComplete="current-password"
          placeholder="Текущий пароль"
          onChange={(e) => setCurPw(e.target.value)}
        />
        <div className="flex gap-2">
          <input
            className="input-field mt-0 flex-1"
            type="password"
            value={newPw}
            autoComplete="new-password"
            placeholder="Новый пароль (от 8 символов)"
            onChange={(e) => setNewPw(e.target.value)}
          />
          <button
            className="btn btn-secondary shrink-0"
            disabled={busy === 'password' || !curPw || newPw.length < 8}
            onClick={savePassword}
          >
            {busy === 'password' ? '…' : 'Сменить'}
          </button>
        </div>
      </div>

      {msg && <p className={`text-[13px] ${msg.ok ? 'text-good' : 'text-danger'}`}>{msg.text}</p>}
    </section>
  );
}

function InvitesCard({ isAdmin }: { isAdmin: boolean }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<Invite | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [grantInvite, setGrantInvite] = useState(false);
  const [note, setNote] = useState('');

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
      const inv = await createInvite(
        isAdmin ? { canInvite: grantInvite, adminNote: note.trim() } : undefined,
      );
      setFreshToken(inv);
      setNote('');
      setGrantInvite(false);
      refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, isAdmin, grantInvite, note]);

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
    const url = absUrl(inv.url);
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
      <h2 className="card-title">Приглашения</h2>

      {isAdmin ? (
        <div className="grid gap-2 border border-line bg-bg-input p-3">
          <input
            className="input-field mt-0"
            value={note}
            maxLength={100}
            placeholder="Никнейм приглашаемого (только для вас)"
            onChange={(e) => setNote(e.target.value)}
          />
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={grantInvite}
              onChange={(e) => setGrantInvite(e.target.checked)}
            />
            Сможет приглашать новых пользователей
          </label>
          <button className="btn btn-primary justify-center" onClick={handleCreate} disabled={busy}>
            {busy ? '…' : 'Создать приглашение'}
          </button>
        </div>
      ) : (
        <button className="btn btn-primary justify-center" onClick={handleCreate} disabled={busy}>
          {busy ? '…' : 'Создать приглашение'}
        </button>
      )}

      {error && <p className="text-[13px] text-danger">{error}</p>}

      {freshToken?.url && (
        <div className="grid gap-2 border border-accent/40 bg-bg-input p-3">
          <span className="section-label">Новая ссылка-приглашение</span>
          <div className="flex gap-2">
            <input
              className="input-field mt-0 flex-1"
              readOnly
              value={absUrl(freshToken.url)}
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
