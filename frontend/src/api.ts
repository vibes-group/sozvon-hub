// Backend REST client. Shapes mirror SPEC.md exactly. Cookie session
// (sh_session) is managed by the server; we only send credentials.

export type User = {
  id: string;
  username: string;
  name: string;
  isAdmin: boolean;
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
  expiresAt?: string;
};

export type RoomStatus = {
  slug: string;
  joinable: boolean;
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

// ---- Invites ----

// Builds the registration link from a token when the backend omits `url`.
export function inviteUrlFromToken(token: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`;
}

export async function createInvite(): Promise<Invite> {
  const body = await request<{ invite: Invite }>('POST', '/api/invites');
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

export async function createRoom(): Promise<RoomCreated> {
  const body = await request<{ room: RoomCreated }>('POST', '/api/rooms');
  const room = body.room;
  if (!room.url && room.slug) room.url = `/r/${room.slug}`;
  return room;
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
