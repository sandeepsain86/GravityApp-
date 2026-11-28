const assert = require('node:assert/strict');
const express = require('express');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { createSuperadminConsole } = require('../src/apps/superadmin/console');

test('Superadmin console shares the main API process without shadowing mobile auth', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gravityhub-console-'));
  const sessions = new Map();
  const sessionRepository = {
    async createSession(hash, userId, expiresAt) {
      sessions.set(hash, { userId, expiresAt });
      return true;
    },
    async createImpersonationSession() { return false; },
    async getSession(hash) {
      const session = sessions.get(hash);
      if (!session || session.expiresAt <= Date.now()) return undefined;
      return { userId: session.userId, expiresAt: session.expiresAt };
    },
    async createLaunch() { return false; },
    async consumeLaunch() { return undefined; },
    async revokeSession(hash) { sessions.delete(hash); },
    async revokeUserSessions(userId) {
      for (const [hash, session] of sessions) {
        if (session.userId === userId) sessions.delete(hash);
      }
    },
    async revokeOtherSessions(userId, exceptHash) {
      for (const [hash, session] of sessions) {
        if (session.userId === userId && hash !== exceptHash) sessions.delete(hash);
      }
    },
    async revokeUserAccess(userId) {
      for (const [hash, session] of sessions) {
        if (session.userId === userId) sessions.delete(hash);
      }
    },
  };
  const superadmin = createSuperadminConsole({
    dataFile: path.join(directory, 'access-control.json'),
    sessionRepository,
  });
  await superadmin.initialize({
    email: 'root@example.com',
    name: 'Root User',
    password: 'Gravityhub-local-password-123',
  });

  const app = express();
  app.use(express.json());
  app.post('/api/auth/login', (_request, response) => {
    response.json({ module: 'mobile-service' });
  });
  app.use('/api/superadmin/auth', require('../src/routes/superadmin/auth.routes'));
  app.use('/api/superadmin/console', superadmin.router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const originalJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-for-registration-authorization';

  try {
    const mobileLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.deepEqual(await mobileLogin.json(), { module: 'mobile-service' });

    const publicRegistration = await fetch(`${baseUrl}/api/superadmin/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Unauthorized',
        email: 'attacker@example.com',
        password: 'Unauthorized-password-123',
      }),
    });
    assert.equal(publicRegistration.status, 401);
    const nonAdminRegistration = await fetch(`${baseUrl}/api/superadmin/auth/register`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt.sign({ id: 'viewer', role: 'viewer' }, process.env.JWT_SECRET)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Unauthorized',
        email: 'attacker@example.com',
        password: 'Unauthorized-password-123',
      }),
    });
    assert.equal(nonAdminRegistration.status, 403);
    const wrongAppRegistration = await fetch(`${baseUrl}/api/superadmin/auth/register`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt.sign(
          { id: 'foreign-admin', role: 'superadmin', app: 'energy-provider' },
          process.env.JWT_SECRET,
        )}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Unauthorized',
        email: 'attacker@example.com',
        password: 'Unauthorized-password-123',
      }),
    });
    assert.equal(wrongAppRegistration.status, 403);

    const demoInfo = await fetch(`${baseUrl}/api/superadmin/console/auth/local-demo`);
    assert.equal(demoInfo.status, 404);

    const login = await fetch(`${baseUrl}/api/superadmin/console/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'root@example.com',
        password: 'Gravityhub-local-password-123',
      }),
    });
    assert.equal(login.status, 200);
    const loginResult = await login.json();
    assert.ok(typeof loginResult.sessionToken === 'string');
    const token = loginResult.sessionToken;

    const session = await fetch(`${baseUrl}/api/superadmin/console/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.email, 'root@example.com');

    const users = await fetch(`${baseUrl}/api/superadmin/console/admin/users`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(users.status, 200);
    const listedUsers = (await users.json()).users;
    assert.ok(listedUsers.some((user) => user.email === 'root@example.com'));
  } finally {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
});
