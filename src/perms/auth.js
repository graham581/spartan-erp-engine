// auth.js — Google idToken verification.
//
// Provides verifyGoogleIdToken(token) → { email, email_verified, sub, aud, iss }.
// N4 fail-closed: any non-AuthError thrown (JWKS outage, bad sig, expiry, unverified email)
// is wrapped as AuthError — a bare Error or 500 must never escape this module.
//
// JWKS: memoised at module scope (one fetch on first call; reused for every subsequent call).

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { loadAuthEnv } from '../validation/env-schema.js';
import { AuthError } from '../runtime/errors.js';

// Lazy-init: set on first verifyGoogleIdToken call, reused after.
let _jwks = null;

function getJwks() {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  }
  return _jwks;
}

/**
 * Verify a Google-issued idToken.
 * Accepts tokens from any client ID listed in GOOGLE_OAUTH_CLIENT_IDS.
 * N4 fail-closed: any failure (JWKS outage, bad sig, expiry, unverified email) → AuthError.
 *
 * @param {string} token
 * @returns {Promise<{ email: string, email_verified: boolean, sub: string, aud: string, iss: string }>}
 * @throws {AuthError}
 */
export async function verifyGoogleIdToken(token) {
  try {
    const { GOOGLE_OAUTH_CLIENT_IDS } = loadAuthEnv();
    const jwks = getJwks();
    const { payload } = await jwtVerify(token, jwks, {
      issuer:       ['https://accounts.google.com', 'accounts.google.com'],
      audience:     GOOGLE_OAUTH_CLIENT_IDS,
      clockTolerance: '5s',
    });

    if (payload.email_verified !== true) {
      throw new AuthError('Google idToken: email not verified');
    }

    return {
      email:          payload.email,
      email_verified: payload.email_verified,
      sub:            payload.sub,
      aud:            payload.aud,
      iss:            payload.iss,
    };
  } catch (err) {
    // Re-throw AuthErrors as-is; wrap everything else (N4 fail-closed).
    if (err instanceof AuthError) throw err;
    throw new AuthError(`Google idToken verification failed: ${err.message}`);
  }
}
