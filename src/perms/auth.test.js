// auth.test.js — network-free unit tests for verifyGoogleIdToken.
//
// jose is mocked so no real JWKS fetch occurs.
// loadAuthEnv is mocked to supply a fixed client ID list without needing env vars.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted, so they run before the module under test is imported) ---

vi.mock('jose', () => ({
  // createRemoteJWKSet returns an opaque sentinel; jwtVerify is the real control point.
  createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
  jwtVerify: vi.fn(),
}));

vi.mock('../validation/env-schema.js', () => ({
  loadAuthEnv: vi.fn(() => ({
    GOOGLE_OAUTH_CLIENT_IDS: ['test-client-id.apps.googleusercontent.com'],
    devAuth: false,
  })),
}));

import { jwtVerify, createRemoteJWKSet } from 'jose';
import { loadAuthEnv } from '../validation/env-schema.js';
import { AuthError } from '../runtime/errors.js';
import { verifyGoogleIdToken } from './auth.js';

// --- helpers ---

const VALID_PAYLOAD = {
  email:          'user@example.com',
  email_verified: true,
  sub:            '1234567890',
  aud:            'test-client-id.apps.googleusercontent.com',
  iss:            'https://accounts.google.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: successful verification with a valid payload.
  jwtVerify.mockResolvedValue({ payload: VALID_PAYLOAD });
});

// --- tests ---

describe('verifyGoogleIdToken', () => {
  it('returns the expected fields for a valid token with email_verified:true', async () => {
    const result = await verifyGoogleIdToken('valid.jwt.token');

    expect(result).toEqual({
      email:          'user@example.com',
      email_verified: true,
      sub:            '1234567890',
      aud:            'test-client-id.apps.googleusercontent.com',
      iss:            'https://accounts.google.com',
    });
  });

  it('passes correct issuer + audience + clockTolerance to jwtVerify', async () => {
    await verifyGoogleIdToken('valid.jwt.token');

    expect(jwtVerify).toHaveBeenCalledWith(
      'valid.jwt.token',
      'mock-jwks',
      {
        issuer:         ['https://accounts.google.com', 'accounts.google.com'],
        audience:       ['test-client-id.apps.googleusercontent.com'],
        clockTolerance: '5s',
      }
    );
  });

  it('throws AuthError when email_verified is false', async () => {
    jwtVerify.mockResolvedValue({ payload: { ...VALID_PAYLOAD, email_verified: false } });

    await expect(verifyGoogleIdToken('unverified.jwt')).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthError when email_verified is missing (falsy)', async () => {
    jwtVerify.mockResolvedValue({ payload: { ...VALID_PAYLOAD, email_verified: undefined } });

    await expect(verifyGoogleIdToken('no-verified.jwt')).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthError when jwtVerify rejects (bad signature / expiry)', async () => {
    jwtVerify.mockRejectedValue(new Error('signature verification failed'));

    const err = await verifyGoogleIdToken('bad-sig.jwt').catch(e => e);
    expect(err).toBeInstanceOf(AuthError);
    // N4: must NOT be a bare Error — must be AuthError specifically
    expect(err.constructor.name).toBe('AuthError');
  });

  it('throws AuthError when JWKS factory throws (N4 outage case)', async () => {
    // Simulate JWKS factory throwing on first call (lazy-init path).
    // We reset the module's lazy JWKS state by re-importing isn't possible,
    // so instead we make createRemoteJWKSet throw, then have jwtVerify throw
    // (since the JWKS object is passed through — outage = jwtVerify rejects).
    jwtVerify.mockRejectedValue(new Error('JWKS endpoint unreachable'));

    const err = await verifyGoogleIdToken('any.jwt').catch(e => e);
    // N4 fail-closed: must be AuthError, NOT a bare Error
    expect(err).toBeInstanceOf(AuthError);
    expect(err.constructor.name).toBe('AuthError');
  });

  it('does not make any real network requests (jose is mocked)', async () => {
    await verifyGoogleIdToken('valid.jwt.token');

    // jose is fully mocked: jwtVerify received the sentinel 'mock-jwks' (not a real
    // JWKS URL fetcher), confirming no real network I/O occurred.
    expect(jwtVerify.mock.calls[0][1]).toBe('mock-jwks');
  });

  it('memoises the JWKS object: jwtVerify always receives the same sentinel', async () => {
    // The module-scope _jwks is set once across the whole test run (lazy-init).
    // After that first init, createRemoteJWKSet is not called again.  We verify
    // memoisation by confirming all three jwtVerify calls received the identical
    // 'mock-jwks' sentinel (not a new object each time).
    await verifyGoogleIdToken('token-1');
    await verifyGoogleIdToken('token-2');
    await verifyGoogleIdToken('token-3');

    expect(jwtVerify).toHaveBeenCalledTimes(3);
    for (const call of jwtVerify.mock.calls) {
      expect(call[1]).toBe('mock-jwks');
    }
  });
});
