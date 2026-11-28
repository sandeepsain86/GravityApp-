import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from './json-store.js';
import { AccessControlService } from '../services/access-control.js';

test('bootstrap state and audit changes persist across store instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'energy-hub-store-'));
  const file = join(directory, 'access-control.json');
  const store = new JsonStore(file);

  try {
    await store.initialize({
      email: 'root@example.com',
      name: 'Root User',
      passwordSalt: 'salt',
      passwordHash: 'hash',
    });
    const actor = (await store.getUserByEmail('root@example.com'))!;
    assert.match(actor.userCode ?? '', /^\d{3}-[A-Z]{2}_$/);
    await store.recordAudit(actor, 'test.event', 'test', 'record', { ok: true });

    const reopened = new JsonStore(file);
    await reopened.initialize({
      email: 'ignored@example.com',
      name: 'Ignored User',
      passwordSalt: 'ignored',
      passwordHash: 'ignored',
    });
    assert.equal((await reopened.listUsers()).length, 1);
    assert.equal((await reopened.getUserByEmail('root@example.com'))?.userCode, actor.userCode);
    assert.equal((await reopened.getUserByEmail('ignored@example.com')), undefined);
    assert.equal((await reopened.listAuditEvents())[0]?.action, 'test.event');
    assert.match(await readFile(file, 'utf8'), /"version": 2/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('profile changes and private avatar files persist across store instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'energy-hub-profile-'));
  const file = join(directory, 'access-control.json');
  const store = new JsonStore(file);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  try {
    await store.initialize({
      email: 'root@example.com',
      name: 'Root User',
      passwordSalt: 'salt',
      passwordHash: 'hash',
    });
    const user = (await store.getUserByEmail('root@example.com'))!;
    await store.updateProfile(user.id, { name: 'Updated Root', phone: '+91 98765 43210' }, user);
    await store.updateCompanyProfile({
      companyName: 'Gravity Energy',
      phone: '',
      email: '',
      gstin: '',
    }, user);
    await store.updateAvatar(user.id, { contentType: 'image/png', bytes: image }, user);

    const reopened = new JsonStore(file);
    await reopened.initialize({
      email: 'ignored@example.com',
      name: 'Ignored User',
      passwordSalt: 'ignored',
      passwordHash: 'ignored',
    });
    const updatedUser = await reopened.getUserById(user.id);
    assert.equal(updatedUser?.name, 'Updated Root');
    assert.equal(updatedUser?.phone, '+91 98765 43210');
    assert.deepEqual(await reopened.getCompanyProfile(), {
      companyName: 'Gravity Energy',
      phone: '',
      email: '',
      gstin: '',
    });
    assert.equal(await reopened.hasAvatar(user.id), true);
    assert.deepEqual((await reopened.getAvatar(user.id))?.bytes, image);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('completing an admin profile persists the first-login setup state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'energy-hub-admin-profile-'));
  const file = join(directory, 'access-control.json');
  const store = new JsonStore(file);

  try {
    await store.initialize({
      email: 'root@example.com',
      name: 'Root User',
      passwordSalt: 'salt',
      passwordHash: 'hash',
    });
    const root = (await store.getUserByEmail('root@example.com'))!;
    const access = new AccessControlService(store);
    const admin = await access.createUser({
      name: 'New Admin',
      email: 'admin@example.com',
      password: 'Admin-password-123',
      role: 'admin',
    }, root);
    assert.equal((await access.sessionUser(admin)).profileSetupRequired, true);

    await store.updateAvatar(admin.id, {
      contentType: 'image/png',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }, admin);
    const updated = await access.updateProfile(admin, {
      name: 'Updated Admin',
      phone: '+91 98765 43210',
      completeSetup: true,
    });
    const reopened = new JsonStore(file);
    await reopened.initialize({
      email: 'ignored@example.com',
      name: 'Ignored User',
      passwordSalt: 'ignored',
      passwordHash: 'ignored',
    });
    const persistedAdmin = (await reopened.getUserById(admin.id))!;
    assert.ok(persistedAdmin.profileCompletedAt);
    assert.equal((await access.sessionUser(updated)).profileSetupRequired, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('version 1 access state revokes viewer access before exposing private directory profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'energy-hub-store-migration-'));
  const file = join(directory, 'access-control.json');
  const store = new JsonStore(file);

  try {
    await store.initialize({
      email: 'root@example.com',
      name: 'Root User',
      passwordSalt: 'salt',
      passwordHash: 'hash',
    });
    const state = JSON.parse(await readFile(file, 'utf8')) as {
      version: number;
      users: Array<Record<string, unknown>>;
      permissions: { viewer: { directory: Record<string, boolean> } };
      auditEvents: Array<{ action: string }>;
    };
    state.version = 1;
    delete state.users[0].userCode;
    state.permissions.viewer.directory = { view: true, create: true, edit: true, delete: true };
    state.users.push({
      ...state.users[0],
      id: 'viewer-id',
      name: 'Read Only',
      email: 'viewer@example.com',
      role: 'viewer',
      permissions: {
        ...state.permissions.viewer,
        directory: { view: true, create: true, edit: true, delete: true },
      },
    });
    await writeFile(file, JSON.stringify(state));

    await new JsonStore(file).initialize({
      email: 'ignored@example.com',
      name: 'Ignored User',
      passwordSalt: 'ignored',
      passwordHash: 'ignored',
    });

    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.permissions.viewer.directory, {
      view: false,
      create: false,
      edit: false,
      delete: false,
    });
    assert.equal(migrated.users[1].permissions.directory.view, false);
    assert.match(migrated.users[0].userCode, /^\d{3}-[A-Z]{2}_$/);
    assert.match(migrated.users[1].userCode, /^\d{3}-[A-Z]{2}_$/);
    assert.notEqual(migrated.users[0].userCode, migrated.users[1].userCode);
    assert.ok(migrated.auditEvents.some((event: { action: string }) =>
      event.action === 'system.access_policy_migrated'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
