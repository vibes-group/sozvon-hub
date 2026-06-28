import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ControlsBar } from './ControlsBar';
import { useStore } from '../store/useStore';
import { useScreenShareStore } from '../store/useScreenShareStore';

function makeHandlers() {
  return {
    onToggleMic: vi.fn(),
    onToggleCamera: vi.fn(),
    onToggleScreenShare: vi.fn(),
    onToggleDeafen: vi.fn(),
    onLeave: vi.fn(),
  };
}

beforeEach(() => {
  useStore.setState({
    selfMuted: false,
    deafened: false,
    cameraOn: false,
  });
  useScreenShareStore.setState({ myStatus: 'idle' });
});

describe('ControlsBar mic button', () => {
  it('shows MicOff and the danger tone when muted', () => {
    useStore.setState({ selfMuted: true });
    render(<ControlsBar {...makeHandlers()} />);
    const btn = screen.getByRole('button', { name: 'Включить микрофон' });
    expect(btn.className).toContain('border-danger');
    expect(btn.querySelector('.lucide-mic-off')).not.toBeNull();
  });

  it('shows Mic and the accent tone when unmuted', () => {
    useStore.setState({ selfMuted: false });
    render(<ControlsBar {...makeHandlers()} />);
    const btn = screen.getByRole('button', { name: 'Выключить микрофон' });
    expect(btn.className).toContain('border-accent');
    expect(btn.className).not.toContain('border-danger');
    expect(btn.querySelector('.lucide-mic')).not.toBeNull();
  });
});

describe('ControlsBar deafen button', () => {
  it('shows the danger tone when deafened', () => {
    useStore.setState({ deafened: true });
    render(<ControlsBar {...makeHandlers()} />);
    const btn = screen.getByRole('button', { name: 'Включить звук' });
    expect(btn.className).toContain('border-danger');
  });

  it('shows the accent tone when not deafened', () => {
    useStore.setState({ deafened: false });
    render(<ControlsBar {...makeHandlers()} />);
    const btn = screen.getByRole('button', { name: 'Выключить звук' });
    expect(btn.className).toContain('border-accent');
  });
});

describe('ControlsBar camera button', () => {
  it('shows the accent tone and Video icon when the camera is on', () => {
    useStore.setState({ cameraOn: true });
    render(<ControlsBar {...makeHandlers()} />);
    const btn = screen.getByRole('button', { name: 'Выключить камеру' });
    expect(btn.className).toContain('border-accent');
    expect(btn.querySelector('.lucide-video')).not.toBeNull();
  });

  it('shows the neutral tone and VideoOff icon when the camera is off', () => {
    useStore.setState({ cameraOn: false });
    render(<ControlsBar {...makeHandlers()} />);
    const btn = screen.getByRole('button', { name: 'Включить камеру' });
    expect(btn.className).not.toContain('border-accent');
    expect(btn.className).not.toContain('border-danger');
    expect(btn.querySelector('.lucide-video-off')).not.toBeNull();
  });
});

describe('ControlsBar leave button', () => {
  it('always uses the danger tone', () => {
    render(<ControlsBar {...makeHandlers()} />);
    const btn = screen.getByRole('button', { name: 'Выйти' });
    expect(btn.className).toContain('border-danger');
  });
});

describe('ControlsBar callbacks', () => {
  it('invokes the matching handler for each control', async () => {
    const handlers = makeHandlers();
    const user = userEvent.setup();
    render(<ControlsBar {...handlers} />);

    await user.click(screen.getByRole('button', { name: 'Включить камеру' }));
    await user.click(screen.getByRole('button', { name: 'Показать экран' }));
    await user.click(screen.getByRole('button', { name: 'Выключить микрофон' }));
    await user.click(screen.getByRole('button', { name: 'Выключить звук' }));
    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    expect(handlers.onToggleCamera).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleScreenShare).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleMic).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleDeafen).toHaveBeenCalledTimes(1);
    expect(handlers.onLeave).toHaveBeenCalledTimes(1);
  });
});
