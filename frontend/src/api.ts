// Backend REST client. Shapes mirror SPEC.md exactly. Cookie session
// (sh_session) is managed by the server; we only send credentials.

export type User = {
  id: string;
  username: string;
  name: string;
  isAdmin: boolean;
  canInvite: boolean;
};

export type Invite = {
  id: string;
  // token is shown once at creation (present on POST /api/invites response).
  token?: string;
  url?: string;
  expiresAt?: string;
  usedAt?: string | null;
};

export type RoomCreated = {
  slug: string;
  url: string;
  name: string;
  expiresAt?: string;
};

export type RoomStatus = {
  slug: string;
  name: string;
  joinable: boolean;
};

export type RoomSummary = {
  slug: string;
  url: string;
  name: string;
  status: string;
  createdAt?: string;
  expiresAt?: string;
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

async function readError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') code = body.error;
  } catch {
    /* no JSON body */
  }
  return new ApiError(res.status, code);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(path, init);
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---- Auth ----

export async function fetchMe(): Promise<User | null> {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (res.status === 401) return null;
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { user?: User };
  return body.user ?? null;
}

export async function register(
  inviteToken: string,
  username: string,
  password: string,
): Promise<User> {
  const body = await request<{ user: User }>('POST', '/api/auth/register', {
    inviteToken,
    username,
    password,
  });
  return body.user;
}

export async function login(username: string, password: string): Promise<User> {
  const body = await request<{ user: User }>('POST', '/api/auth/login', {
    username,
    password,
  });
  return body.user;
}

export async function logout(): Promise<void> {
  await request<void>('POST', '/api/auth/logout');
}

// Update the caller's display name and/or username. Username must be unique
// (throws ApiError code 'username_taken' otherwise).
export async function updateAccount(patch: {
  username?: string;
  name?: string;
}): Promise<User> {
  const body = await request<{ user: User }>('PATCH', '/api/account', patch);
  return body.user;
}

// Change the caller's password. Throws ApiError 'invalid_credentials' when the
// current password is wrong, 'invalid_password' when the new one is too short.
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await request<void>('POST', '/api/account/password', { currentPassword, newPassword });
}

// ---- Invites ----

// Builds the registration link from a token when the backend omits `url`.
export function inviteUrlFromToken(token: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`;
}

export async function createInvite(opts?: {
  canInvite?: boolean;
  adminNote?: string;
}): Promise<Invite> {
  const body = await request<{ invite: Invite }>('POST', '/api/invites', opts ?? {});
  const invite = body.invite;
  if (!invite.url && invite.token) invite.url = inviteUrlFromToken(invite.token);
  return invite;
}

export async function listInvites(): Promise<Invite[]> {
  const body = await request<{ invites: Invite[] }>('GET', '/api/invites');
  return body.invites ?? [];
}

export async function revokeInvite(id: string): Promise<void> {
  await request<void>('DELETE', `/api/invites/${encodeURIComponent(id)}`);
}

// ---- Rooms ----

export async function createRoom(name?: string): Promise<RoomCreated> {
  const trimmed = name?.trim() ?? '';
  const body = await request<{ room: RoomCreated }>(
    'POST',
    '/api/rooms',
    trimmed ? { name: trimmed } : {},
  );
  const room = body.room;
  if (!room.url && room.slug) room.url = `/r/${room.slug}`;
  return room;
}

// Rename a room. Only the creator may rename it (the server enforces this and
// returns 404 otherwise).
export async function renameRoom(slug: string, name: string): Promise<void> {
  await request<void>('PATCH', `/api/rooms/${encodeURIComponent(slug)}`, { name: name.trim() });
}

export async function fetchRoom(slug: string): Promise<RoomStatus | null> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(slug)}`, {
    credentials: 'same-origin',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { room?: RoomStatus };
  return body.room ?? null;
}

export async function listMyRooms(): Promise<RoomSummary[]> {
  const body = await request<{ rooms: RoomSummary[] }>('GET', '/api/rooms');
  return body.rooms ?? [];
}

// Rooms the caller has joined but did not create (logged-in users only).
export async function listJoinedRooms(): Promise<RoomSummary[]> {
  const body = await request<{ rooms: RoomSummary[] }>('GET', '/api/rooms/joined');
  return body.rooms ?? [];
}

// ---- Admin ----

export type AdminUserView = {
  id: string;
  username: string;
  name: string;
  isAdmin: boolean;
  canInvite: boolean;
  adminNote: string;
  createdAt: string;
  lastSeenAt: string;
};

// Absolute, shareable URL for a room from its slug.
export function roomUrl(slug: string): string {
  return `${window.location.origin}/r/${slug}`;
}

// Share a room link in one click. On mobile (where the Web Share API exists)
// this opens the native share sheet; on desktop it falls back to copying the
// link to the clipboard. A user-cancelled share sheet is not an error.
export async function shareRoom(slug: string): Promise<'shared' | 'copied' | 'fail'> {
  const url = roomUrl(slug);
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Созвон', url });
      return 'shared';
    } catch (e) {
      // AbortError = user dismissed the sheet; treat as a no-op, not a failure.
      if (e instanceof DOMException && e.name === 'AbortError') return 'fail';
      // Otherwise fall through to clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'fail';
  }
}

export async function adminListUsers(): Promise<AdminUserView[]> {
  const body = await request<{ users: AdminUserView[] }>('GET', '/api/admin/users');
  return body.users ?? [];
}

export async function adminUpdateUser(
  id: string,
  patch: { canInvite?: boolean; adminNote?: string },
): Promise<void> {
  await request<void>('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, patch);
}
