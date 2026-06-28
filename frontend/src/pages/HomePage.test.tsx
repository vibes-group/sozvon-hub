import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import HomePage from './HomePage';
import { ApiError } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    fetchMe: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    listMyRooms: vi.fn(),
    listInvites: vi.fn(),
    adminListUsers: vi.fn(),
  };
});

import {
  fetchMe,
  login,
  register,
  listMyRooms,
  listInvites,
  adminListUsers,
  type User,
} from '../api';

const fetchMeMock = vi.mocked(fetchMe);
const loginMock = vi.mocked(login);
const registerMock = vi.mocked(register);

const USER: User = {
  id: 'u1',
  username: 'alice',
  name: 'Alice',
  isAdmin: false,
  canInvite: false,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <HomePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMyRooms).mockResolvedValue([]);
  vi.mocked(listInvites).mockResolvedValue([]);
  vi.mocked(adminListUsers).mockResolvedValue([]);
});

describe('HomePage when logged out', () => {
  it('renders the login form once fetchMe resolves to null', async () => {
    fetchMeMock.mockResolvedValue(null);
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Вход' })).toBeInTheDocument();
  });

  it('submits credentials via login() and reveals the dashboard on success', async () => {
    fetchMeMock.mockResolvedValue(null);
    loginMock.mockResolvedValue(USER);
    const user = userEvent.setup();
    renderAt('/');

    await screen.findByRole('heading', { name: 'Вход' });
    await user.type(screen.getByLabelText('Логин'), '  alice  ');
    await user.type(screen.getByLabelText('Пароль'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(loginMock).toHaveBeenCalledWith('alice', 'secret');
    expect(await screen.findByText(/Вы вошли как/)).toBeInTheDocument();
  });

  it('shows the mapped Russian error when login fails with a known code', async () => {
    fetchMeMock.mockResolvedValue(null);
    loginMock.mockRejectedValue(new ApiError(401, 'invalid_credentials'));
    const user = userEvent.setup();
    renderAt('/');

    await screen.findByRole('heading', { name: 'Вход' });
    await user.type(screen.getByLabelText('Логин'), 'alice');
    await user.type(screen.getByLabelText('Пароль'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('Неверный логин или пароль.')).toBeInTheDocument();
  });
});

describe('HomePage with an invite token in the URL', () => {
  it('renders the registration form', async () => {
    fetchMeMock.mockResolvedValue(null);
    renderAt('/?invite=tok-123');
    expect(await screen.findByRole('heading', { name: 'Регистрация' })).toBeInTheDocument();
  });

  it('submits via register() with the invite token from the URL', async () => {
    fetchMeMock.mockResolvedValue(null);
    registerMock.mockResolvedValue(USER);
    const user = userEvent.setup();
    renderAt('/?invite=tok-123');

    await screen.findByRole('heading', { name: 'Регистрация' });
    await user.type(screen.getByLabelText('Логин'), 'newbie');
    await user.type(screen.getByLabelText('Пароль'), 'longenough');
    await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }));

    expect(registerMock).toHaveBeenCalledWith('tok-123', 'newbie', 'longenough');
  });
});

describe('HomePage loading state', () => {
  it('shows the loading placeholder until fetchMe settles', async () => {
    let resolve!: (u: User | null) => void;
    fetchMeMock.mockReturnValue(new Promise<User | null>((r) => (resolve = r)));
    renderAt('/');
    expect(screen.getByText('Загрузка…')).toBeInTheDocument();
    resolve(null);
    await waitFor(() => expect(screen.queryByText('Загрузка…')).not.toBeInTheDocument());
  });
});
