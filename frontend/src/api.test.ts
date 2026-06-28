import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  fetchMe,
  register,
  login,
  logout,
  updateAccount,
  createInvite,
  listInvites,
  revokeInvite,
  createRoom,
  fetchRoom,
  listMyRooms,
  adminListUsers,
  adminUpdateUser,
  inviteUrlFromToken,
  type User,
} from './api';

const USER: User = {
  id: 'u1',
  username: 'alice',
  name: 'Alice',
  isAdmin: false,
  canInvite: true,
};

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  const status = init?.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Returns [url, init] of the Nth fetch call (0-based). */
function callArgs(n = 0): [string, RequestInit] {
  const [url, init] = fetchMock.mock.calls[n];
  return [url as string, (init ?? {}) as RequestInit];
}

function parseBody(init: RequestInit): unknown {
  return init.body == null ? undefined : JSON.parse(init.body as string);
}

describe('fetchMe', () => {
  it('returns null on 401', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(401));
    expect(await fetchMe()).toBeNull();
    const [url, init] = callArgs();
    expect(url).toBe('/api/auth/me');
    expect(init.credentials).toBe('same-origin');
  });

  it('returns the user on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: USER }));
    expect(await fetchMe()).toEqual(USER);
  });

  it('returns null when the body has no user', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    expect(await fetchMe()).toBeNull();
  });

  it('throws ApiError on other non-ok statuses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, { status: 500 }));
    await expect(fetchMe()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('register', () => {
  it('POSTs to /api/auth/register with the invite token and credentials, returns body.user', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: USER }));
    const result = await register('tok-1', 'alice', 'pw12345678');
    expect(result).toEqual(USER);
    const [url, init] = callArgs();
    expect(url).toBe('/api/auth/register');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(parseBody(init)).toEqual({
      inviteToken: 'tok-1',
      username: 'alice',
      password: 'pw12345678',
    });
  });
});

describe('login', () => {
  it('POSTs to /api/auth/login with username and password, returns body.user', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: USER }));
    const result = await login('alice', 'secret');
    expect(result).toEqual(USER);
    const [url, init] = callArgs();
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(parseBody(init)).toEqual({ username: 'alice', password: 'secret' });
  });

  it('throws ApiError carrying the server error code on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'invalid_credentials' }, { status: 401 }),
    );
    const err = await login('alice', 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('invalid_credentials');
  });

  it('falls back to http_<status> when no error code is present', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(403));
    const err = await login('alice', 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('http_403');
  });
});

describe('logout', () => {
  it('POSTs to /api/auth/logout', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    await logout();
    const [url, init] = callArgs();
    expect(url).toBe('/api/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
  });
});

describe('updateAccount', () => {
  it('PATCHes /api/account with the patch, returns body.user', async () => {
    const updated = { ...USER, name: 'Bob' };
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: updated }));
    const result = await updateAccount({ name: 'Bob' });
    expect(result).toEqual(updated);
    const [url, init] = callArgs();
    expect(url).toBe('/api/account');
    expect(init.method).toBe('PATCH');
    expect(parseBody(init)).toEqual({ name: 'Bob' });
  });
});

describe('createInvite', () => {
  it('sends an empty object body when called with no args', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ invite: { id: 'i1', url: '/?invite=x' } }));
    await createInvite();
    const [url, init] = callArgs();
    expect(url).toBe('/api/invites');
    expect(init.method).toBe('POST');
    expect(parseBody(init)).toEqual({});
  });

  it('forwards canInvite and adminNote when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ invite: { id: 'i1', url: '/?invite=x' } }));
    await createInvite({ canInvite: true, adminNote: 'note' });
    const [, init] = callArgs();
    expect(parseBody(init)).toEqual({ canInvite: true, adminNote: 'note' });
  });

  it('derives a url from the token when the server omits url', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ invite: { id: 'i1', token: 'abc def' } }));
    const inv = await createInvite();
    expect(inv.url).toBe(inviteUrlFromToken('abc def'));
    expect(inv.url).toContain('invite=abc%20def');
  });

  it('keeps the server-provided url untouched', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ invite: { id: 'i1', token: 't', url: 'https://x/invite' } }),
    );
    const inv = await createInvite();
    expect(inv.url).toBe('https://x/invite');
  });
});

describe('listInvites', () => {
  it('GETs /api/invites and returns the invites array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ invites: [{ id: 'i1' }, { id: 'i2' }] }));
    const invites = await listInvites();
    expect(invites).toHaveLength(2);
    const [url, init] = callArgs();
    expect(url).toBe('/api/invites');
    expect(init.method).toBe('GET');
  });

  it('returns an empty array when the body has no invites', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    expect(await listInvites()).toEqual([]);
  });
});

describe('revokeInvite', () => {
  it('DELETEs /api/invites/<id> with the id URL-encoded', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    await revokeInvite('a/b');
    const [url, init] = callArgs();
    expect(url).toBe('/api/invites/a%2Fb');
    expect(init.method).toBe('DELETE');
    expect(init.credentials).toBe('same-origin');
  });
});

describe('createRoom', () => {
  it('POSTs /api/rooms and returns the room', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ room: { slug: 's1', url: '/r/s1' } }));
    const room = await createRoom();
    expect(room).toEqual({ slug: 's1', url: '/r/s1' });
    const [url, init] = callArgs();
    expect(url).toBe('/api/rooms');
    expect(init.method).toBe('POST');
  });

  it('derives a /r/<slug> url when the server omits url', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ room: { slug: 's2' } }));
    const room = await createRoom();
    expect(room.url).toBe('/r/s2');
  });
});

describe('fetchRoom', () => {
  it('returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(404));
    expect(await fetchRoom('gone')).toBeNull();
    const [url, init] = callArgs();
    expect(url).toBe('/api/rooms/gone');
    expect(init.credentials).toBe('same-origin');
  });

  it('returns the room status on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ room: { slug: 's1', joinable: true } }));
    expect(await fetchRoom('s1')).toEqual({ slug: 's1', joinable: true });
  });

  it('URL-encodes the slug', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ room: { slug: 'a b', joinable: false } }));
    await fetchRoom('a b');
    const [url] = callArgs();
    expect(url).toBe('/api/rooms/a%20b');
  });

  it('throws ApiError on other non-ok statuses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, { status: 500 }));
    await expect(fetchRoom('s1')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('listMyRooms', () => {
  it('GETs /api/rooms and returns the rooms array', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ rooms: [{ slug: 's1', url: '/r/s1', status: 'active' }] }),
    );
    const rooms = await listMyRooms();
    expect(rooms).toHaveLength(1);
    const [url, init] = callArgs();
    expect(url).toBe('/api/rooms');
    expect(init.method).toBe('GET');
  });
});

describe('adminListUsers', () => {
  it('GETs /api/admin/users and returns the users array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ users: [{ id: 'u1' }] }));
    const users = await adminListUsers();
    expect(users).toHaveLength(1);
    const [url, init] = callArgs();
    expect(url).toBe('/api/admin/users');
    expect(init.method).toBe('GET');
  });

  it('returns an empty array when the body has no users', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    expect(await adminListUsers()).toEqual([]);
  });
});

describe('adminUpdateUser', () => {
  it('PATCHes /api/admin/users/<id> with the patch body', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    await adminUpdateUser('u1', { canInvite: true, adminNote: 'vip' });
    const [url, init] = callArgs();
    expect(url).toBe('/api/admin/users/u1');
    expect(init.method).toBe('PATCH');
    expect(parseBody(init)).toEqual({ canInvite: true, adminNote: 'vip' });
  });

  it('URL-encodes the user id', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    await adminUpdateUser('a/b', { canInvite: false });
    const [url] = callArgs();
    expect(url).toBe('/api/admin/users/a%2Fb');
  });
});

describe('inviteUrlFromToken', () => {
  it('builds an absolute invite url from the current origin', () => {
    expect(inviteUrlFromToken('tok')).toBe(`${window.location.origin}/?invite=tok`);
  });

  it('URL-encodes the token', () => {
    expect(inviteUrlFromToken('a b&c')).toBe(`${window.location.origin}/?invite=a%20b%26c`);
  });
});
