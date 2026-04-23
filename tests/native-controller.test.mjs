import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationDbPath,
  status,
} from '../native-controller.mjs';

test('native notification db path points at macOS usernoted database', () => {
  assert.match(notificationDbPath(), /group\.com\.apple\.usernoted\/db2\/db$/);
});

test('native status reports backend shape without throwing', async () => {
  const s = await status();
  assert.equal(s.backend, 'native');
  assert.ok(['not_running', 'ready', 'needs_accessibility_permission'].includes(s.state));
  assert.equal(typeof s.ax_trusted, 'boolean');
});
