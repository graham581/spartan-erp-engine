import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryStore } from '../runtime/memory-store.js';
import { registerDoctype, _resetRegistry } from '../meta/registry.js';
import { registerBootMeta } from '../meta/boot-meta.js';
import { makeContext, GUEST } from '../perms/context.js';
import { handle } from './handler.js';
import { ctxFromRequest } from './context-from-request.js';
import { AuthError } from '../runtime/errors.js';

function seed() {
  registerDoctype({
    doctype: 'Job', table: 'tabJob', submittable: true, autoname: 'JOB-.#####', scopeFields: ['branch'],
    fields: [
      { fieldname: 'title', fieldtype: 'Data', reqd: true, permlevel: 0 },
      { fieldname: 'branch', fieldtype: 'Data', permlevel: 0 },
      { fieldname: 'margin', fieldtype: 'Currency', permlevel: 1 },
    ],
    childTables: [],
    permissions: [
      { role: 'rep', doctype: 'Job', permlevel: 0, read: true, ifOwner: true },
      { role: 'rep', doctype: 'Job', permlevel: 0, write: true, ifOwner: true },
      { role: 'rep', doctype: 'Job', permlevel: 0, create: true },
      { role: 'viewer', doctype: 'Job', permlevel: 0, read: true },
    ],
  });
}

const rep = makeContext({ user: 'rep@x', roles: ['rep'], scopes: { branch: 'VIC' } });
const viewer = makeContext({ user: 'v@x', roles: ['viewer'], scopes: { branch: 'VIC' } });

describe('handler — method/action dispatch + error→status', () => {
  /** @type {MemoryStore} */
  let store;
  beforeEach(() => { _resetRegistry(); registerBootMeta(); seed(); store = new MemoryStore(); });

  it('POST collection creates -> 200', async () => {
    const r = await handle({ method: 'POST', doctype: 'Job', name: null, body: { title: 'A', branch: 'VIC' }, ctx: rep }, store);
    expect(r.status).toBe(200);
    expect(r.body.owner).toBe('rep@x');
  });

  it('GET collection lists -> 200', async () => {
    await handle({ method: 'POST', doctype: 'Job', body: { title: 'A', branch: 'VIC' }, ctx: rep }, store);
    const r = await handle({ method: 'GET', doctype: 'Job', name: null, ctx: rep }, store);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
  });

  it('GET missing record -> 404', async () => {
    const r = await handle({ method: 'GET', doctype: 'Job', name: 'NOPE', ctx: rep }, store);
    expect(r.status).toBe(404);
    expect(r.body.type).toBe('NotFoundError');
  });

  it('create missing required field -> 400', async () => {
    const r = await handle({ method: 'POST', doctype: 'Job', body: { branch: 'VIC' }, ctx: rep }, store);
    expect(r.status).toBe(400);
    expect(r.body.type).toBe('ValidationError');
  });

  it('viewer create -> 403', async () => {
    const r = await handle({ method: 'POST', doctype: 'Job', body: { title: 'A', branch: 'VIC' }, ctx: viewer }, store);
    expect(r.status).toBe(403);
    expect(r.body.type).toBe('PermissionError');
  });

  it('POST item update -> 200; writing margin -> 403', async () => {
    const c = await handle({ method: 'POST', doctype: 'Job', body: { title: 'A', branch: 'VIC' }, ctx: rep }, store);
    const ok = await handle({ method: 'POST', doctype: 'Job', name: c.body.name, body: { title: 'B' }, ctx: rep }, store);
    expect(ok.status).toBe(200);
    const bad = await handle({ method: 'POST', doctype: 'Job', name: c.body.name, body: { margin: 99 }, ctx: rep }, store);
    expect(bad.status).toBe(403);
  });

  it('submit by rep -> 403; unknown action -> 400', async () => {
    const c = await handle({ method: 'POST', doctype: 'Job', body: { title: 'A', branch: 'VIC' }, ctx: rep }, store);
    const s = await handle({ method: 'POST', doctype: 'Job', name: c.body.name, body: { action: 'submit' }, ctx: rep }, store);
    expect(s.status).toBe(403);
    // unknown action routes to the workflow; this Job has no workflow registered -> StateError -> 409
    const u = await handle({ method: 'POST', doctype: 'Job', name: c.body.name, body: { action: 'frobnicate' }, ctx: rep }, store);
    expect(u.status).toBe(409);
  });

  it('DELETE method -> 405', async () => {
    const r = await handle({ method: 'DELETE', doctype: 'Job', name: 'X', ctx: rep }, store);
    expect(r.status).toBe(405);
  });
});

describe('handler — N6 dead-shim: devAuth=false + x-spartan-* headers → GUEST', () => {
  it('N6: no bearer, devAuth disabled (default) → ctxFromRequest returns GUEST', async () => {
    // ctxFromRequest calls loadAuthEnv() to check devAuth; mock it to return devAuth:false
    // (simulates the prod default where DEV_AUTH is not set).
    const envMod = await import('../validation/env-schema.js');
    const envSpy = vi.spyOn(envMod, 'loadAuthEnv').mockReturnValue({
      GOOGLE_OAUTH_CLIENT_IDS: [],
      devAuth: false,
    });
    const stubStore = new MemoryStore();
    const stubReq = {
      headers: {
        'x-spartan-user': 'rep@x',
        'x-spartan-roles': 'rep',
        'x-spartan-branch': 'VIC',
        // no 'authorization' header
      },
    };
    // When devAuth is off, the x-spartan-* shim is dead: ctxFromRequest must return GUEST.
    const ctx = await ctxFromRequest(stubReq, stubStore);
    expect(ctx).toEqual(GUEST);
    envSpy.mockRestore();
  });
});

describe('handler — statusFor: AuthError → 401', () => {
  // Verify the AuthError → 401 mapping by having handle() catch an AuthError thrown from
  // a mocked service. The service is mocked to throw so we can reach the catch branch
  // without needing a real bearer token round-trip.
  it('statusFor(new AuthError) → 401 via handle() catch branch', async () => {
    const store = new MemoryStore();
    // Stub a minimal registered doctype so ensure() succeeds.
    _resetRegistry();
    registerBootMeta();
    registerDoctype({
      doctype: 'Job', table: 'tabJob', scopeFields: [],
      fields: [{ fieldname: 'title', fieldtype: 'Data', permlevel: 0 }],
      childTables: [],
      permissions: [{ role: 'rep', doctype: 'Job', permlevel: 0, read: true }],
    });
    // Mock listDocs (the GET collection path) to throw an AuthError.
    const svcMod = await import('./service.js');
    const spy = vi.spyOn(svcMod, 'listDocs').mockRejectedValueOnce(new AuthError('session expired'));
    const ctx = makeContext({ user: 'rep@x', roles: ['rep'] });
    const r = await handle({ method: 'GET', doctype: 'Job', name: null, ctx }, store);
    expect(r.status).toBe(401);
    expect(r.body.type).toBe('AuthError');
    spy.mockRestore();
  });
});
