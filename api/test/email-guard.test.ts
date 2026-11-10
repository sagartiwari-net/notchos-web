import { describe, expect, it } from 'vitest';
import { guardEmailSync, guardMessage } from '../src/lib/email-guard.ts';

describe('email-guard', () => {
  it('accepts a normal gmail address', () => {
    const r = guardEmailSync('Friend.Name+tag@Gmail.com');
    expect(r).toEqual({ ok: true, email: 'friend.name+tag@gmail.com' });
  });

  it('rejects disposable domains', () => {
    const r = guardEmailSync('x@mailinator.com');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('disposable');
      expect(guardMessage(r)).toMatch(/disposable/i);
    }
  });

  it('rejects gma.com typo with a hint', () => {
    const r = guardEmailSync('ak422979@gma.com');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('typo');
      expect(r.hint).toBe('ak422979@gmail.com');
    }
  });

  it('rejects empty / junk', () => {
    expect(guardEmailSync('').ok).toBe(false);
    expect(guardEmailSync('not-an-email').ok).toBe(false);
    expect(guardEmailSync('a@b.c').ok).toBe(false);
  });
});
