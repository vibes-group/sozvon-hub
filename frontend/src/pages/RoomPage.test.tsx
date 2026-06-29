import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import RoomPage from './RoomPage';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return { ...actual, fetchRoom: vi.fn(), fetchMe: vi.fn() };
});

vi.mock('../components/CallScreen', () => ({
  CallScreen: () => <div data-testid="call-screen" />,
}));

import { fetchRoom, fetchMe } from '../api';

const fetchRoomMock = vi.mocked(fetchRoom);

function renderRoom(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/r/${slug}`]}>
      <Routes>
        <Route path="/r/:slug" element={<RoomPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchMe).mockResolvedValue(null);
  sessionStorage.clear();
  localStorage.clear();
});

describe('RoomPage', () => {
  it('shows the unavailable card when the room is missing', async () => {
    fetchRoomMock.mockResolvedValue(null);
    renderRoom('gone');
    expect(await screen.findByText('Комната недоступна')).toBeInTheDocument();
  });

  it('shows the unavailable card when the room is not joinable', async () => {
    fetchRoomMock.mockResolvedValue({ slug: 'full', name: '', joinable: false });
    renderRoom('full');
    expect(await screen.findByText('Комната недоступна')).toBeInTheDocument();
  });

  it('shows the name prompt when the room is joinable', async () => {
    fetchRoomMock.mockResolvedValue({ slug: 'ok', name: 'Тест', joinable: true });
    renderRoom('ok');
    expect(await screen.findByRole('heading', { name: 'Вход в звонок' })).toBeInTheDocument();
    expect(screen.getByLabelText('Ваше имя')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Присоединиться' })).toBeInTheDocument();
  });

  it('re-joins automatically on reload when the tab already joined this room', async () => {
    fetchRoomMock.mockResolvedValue({ slug: 'ok', name: 'Тест', joinable: true });
    sessionStorage.setItem('sozvon-hub.joined-room.ok', '1');
    renderRoom('ok');
    expect(await screen.findByTestId('call-screen')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Вход в звонок' })).not.toBeInTheDocument();
  });

  it('does not auto-join an unavailable room even if previously joined', async () => {
    fetchRoomMock.mockResolvedValue({ slug: 'gone', name: '', joinable: false });
    sessionStorage.setItem('sozvon-hub.joined-room.gone', '1');
    renderRoom('gone');
    expect(await screen.findByText('Комната недоступна')).toBeInTheDocument();
    expect(screen.queryByTestId('call-screen')).not.toBeInTheDocument();
  });

  it('surfaces an error message when fetchRoom rejects', async () => {
    fetchRoomMock.mockRejectedValue(new Error('network down'));
    renderRoom('boom');
    expect(await screen.findByText('Ошибка')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
  });
});
