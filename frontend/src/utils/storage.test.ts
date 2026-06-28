import { describe, it, expect, beforeEach } from 'vitest';
import {
  KEYS,
  loadEngine,
  saveEngine,
  loadBoolean,
  saveBoolean,
  loadNumber,
  loadDisplayName,
  saveDisplayName,
  loadPeerVolume,
  savePeerVolume,
} from './storage';

beforeEach(() => {
  localStorage.clear();
});

describe('loadEngine / saveEngine', () => {
  it('defaults to browser when unset', () => {
    expect(loadEngine()).toBe('browser');
  });

  it('defaults to browser when the stored value is not a known engine', () => {
    localStorage.setItem(KEYS.engine, 'bogus');
    expect(loadEngine()).toBe('browser');
  });

  it('round-trips off', () => {
    saveEngine('off');
    expect(loadEngine()).toBe('off');
  });

  it('round-trips rnnoise', () => {
    saveEngine('rnnoise');
    expect(loadEngine()).toBe('rnnoise');
  });
});

describe('loadBoolean / saveBoolean', () => {
  it('returns the fallback when unset', () => {
    expect(loadBoolean('k', true)).toBe(true);
    expect(loadBoolean('k', false)).toBe(false);
  });

  it('round-trips true and false', () => {
    saveBoolean('k', true);
    expect(loadBoolean('k', false)).toBe(true);
    saveBoolean('k', false);
    expect(loadBoolean('k', true)).toBe(false);
  });

  it('treats any non-"true" string as false', () => {
    localStorage.setItem('k', 'yes');
    expect(loadBoolean('k', true)).toBe(false);
  });
});

describe('loadNumber', () => {
  it('returns the fallback when unset or empty', () => {
    expect(loadNumber('n', 42)).toBe(42);
    localStorage.setItem('n', '');
    expect(loadNumber('n', 42)).toBe(42);
  });

  it('returns the fallback when the stored value is not finite', () => {
    localStorage.setItem('n', 'not-a-number');
    expect(loadNumber('n', 7)).toBe(7);
  });

  it('round-trips a numeric string', () => {
    localStorage.setItem('n', '123');
    expect(loadNumber('n', 0)).toBe(123);
  });
});

describe('loadDisplayName / saveDisplayName', () => {
  it('defaults to an empty string', () => {
    expect(loadDisplayName()).toBe('');
  });

  it('round-trips and trims the saved name', () => {
    saveDisplayName('  Alice  ');
    expect(loadDisplayName()).toBe('Alice');
  });
});

describe('loadPeerVolume / savePeerVolume', () => {
  it('returns null for an unknown peer', () => {
    expect(loadPeerVolume('peer-1')).toBeNull();
  });

  it('returns null for an empty clientId', () => {
    expect(loadPeerVolume('')).toBeNull();
  });

  it('does not write when clientId is empty', () => {
    savePeerVolume('', 80);
    expect(localStorage.length).toBe(0);
  });

  it('round-trips a per-peer volume keyed by clientId', () => {
    savePeerVolume('peer-1', 150);
    savePeerVolume('peer-2', 50);
    expect(loadPeerVolume('peer-1')).toBe(150);
    expect(loadPeerVolume('peer-2')).toBe(50);
  });

  it('returns null when the stored value is not finite', () => {
    savePeerVolume('peer-1', 100);
    localStorage.setItem('sozvon-hub.peer-volume.peer-1', 'oops');
    expect(loadPeerVolume('peer-1')).toBeNull();
  });
});
