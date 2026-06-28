import { describe, it, expect } from 'vitest';
import {
  ENGINE_OPTIONS,
  ENGINE_IDS,
  formatEngine,
  isCaptureEngine,
} from './engine';

describe('ENGINE_OPTIONS', () => {
  it('includes the browser capture engine and the rnnoise denoiser', () => {
    expect(ENGINE_IDS).toContain('browser');
    expect(ENGINE_IDS).toContain('rnnoise');
  });

  it('pairs every option value with a human label', () => {
    for (const opt of ENGINE_OPTIONS) {
      expect(typeof opt.value).toBe('string');
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });
});

describe('formatEngine', () => {
  it('maps off to the Russian "off" label', () => {
    expect(formatEngine('off')).toBe('Выкл.');
  });

  it('maps browser to the browser label', () => {
    expect(formatEngine('browser')).toBe('Браузерное');
  });

  it('maps rnnoise to the RNNoise label', () => {
    expect(formatEngine('rnnoise')).toBe('RNNoise');
  });

  it('echoes an unknown engine id back unchanged', () => {
    expect(formatEngine('mystery')).toBe('mystery');
  });
});

describe('isCaptureEngine', () => {
  it('is true for browser', () => {
    expect(isCaptureEngine('browser')).toBe(true);
  });

  it('is false for the rnnoise denoiser', () => {
    expect(isCaptureEngine('rnnoise')).toBe(false);
  });

  it('is false for off', () => {
    expect(isCaptureEngine('off')).toBe(false);
  });
});
