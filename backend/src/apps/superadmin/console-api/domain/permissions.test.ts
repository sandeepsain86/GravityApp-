import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultPermissionMatrixSync,
  hasPermission,
  validateRolePermissions,
} from './permissions.js';

test('default matrix gives superadmin full access and viewer read-only access', () => {
  const matrix = createDefaultPermissionMatrixSync();

  assert.equal(hasPermission('superadmin', matrix, 'users', 'delete'), true);
  assert.equal(hasPermission('viewer', matrix, 'jobs', 'view'), true);
  assert.equal(hasPermission('viewer', matrix, 'jobs', 'edit'), false);
  assert.equal(hasPermission('viewer', matrix, 'directory', 'view'), false);
  assert.equal(hasPermission('admin', matrix, 'users', 'view'), false);
});

test('permission updates must contain every page and action as booleans', () => {
  const matrix = createDefaultPermissionMatrixSync();
  assert.equal(validateRolePermissions(matrix.admin), true);

  const invalid = structuredClone(matrix.admin);
  delete (invalid.jobs as Partial<typeof invalid.jobs>).delete;
  assert.equal(validateRolePermissions(invalid), false);
});
