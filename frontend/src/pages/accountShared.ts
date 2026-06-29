import { ApiError } from '../api';

export const ERROR_RU: Record<string, string> = {
  invalid_credentials: 'Неверный логин или пароль.',
  invalid_username: 'Недопустимый логин.',
  invalid_name: 'Недопустимое имя.',
  invalid_password: 'Пароль должен быть не короче 8 символов.',
  username_taken: 'Этот логин уже занят.',
  invalid_invite: 'Приглашение недействительно или истекло.',
  invite_required: 'Нужно действительное приглашение.',
  invite_used: 'Приглашение уже использовано.',
};

export function errText(err: unknown): string {
  if (err instanceof ApiError) return ERROR_RU[err.code] ?? `Ошибка: ${err.code}`;
  return err instanceof Error ? err.message : 'Неизвестная ошибка';
}

export function absUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return `${window.location.origin}${path}`;
}

export function fmtDateTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}
