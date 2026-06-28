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
});

describe('RoomPage', () => {
  it('shows the unavailable card when the room is missing', async () => {
    fetchRoomMock.mockResolvedValue(null);
    renderRoom('gone');
    expect(await screen.findByText('Комната недоступна')).toBeInTheDocument();
  });

  it('shows the unavailable card when the room is not joinable', async () => {
    fetchRoomMock.mockResolvedValue({ slug: 'full', joinable: false });
    renderRoom('full');
    expect(await screen.findByText('Комната недоступна')).toBeInTheDocument();
  });

  it('shows the name prompt when the room is joinable', async () => {
    fetchRoomMock.mockResolvedValue({ slug: 'ok', joinable: true });
    renderRoom('ok');
    expect(await screen.findByRole('heading', { name: 'Вход в звонок' })).toBeInTheDocument();
    expect(screen.getByLabelText('Ваше имя')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Присоединиться' })).toBeInTheDocument();
  });

  it('surfaces an error message when fetchRoom rejects', async () => {
    fetchRoomMock.mockRejectedValue(new Error('network down'));
    renderRoom('boom');
    expect(await screen.findByText('Ошибка')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
  });
});
