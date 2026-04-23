import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claimRequestLock,
  fetch,
  readRequest,
  releaseRequestLock,
  removeRequest,
  submit,
  updateRequest,
  verifyResponseFiles,
  writeResponseVerified,
} from '../mailbox.mjs';
import {
  probeNativeRequest,
  submitNativeRequest,
} from '../daemon-core.mjs';

async function withMailboxHome(fn) {
  const prevExo = process.env.EXOCORTEX_HOME;
  const home = await mkdtemp(join(tmpdir(), 'chatgpt-native-daemon-core-'));
  process.env.EXOCORTEX_HOME = home;
  try {
    return await fn(join(home, 'chatgpt'));
  } finally {
    if (prevExo == null) delete process.env.EXOCORTEX_HOME;
    else process.env.EXOCORTEX_HOME = prevExo;
  }
}

test('submitNativeRequest moves pending request to generating and keeps request file', async () => {
  await withMailboxHome(async () => {
    const { request_id } = await submit('hello', { agent: 'alpha' });
    const lockPath = await claimRequestLock(request_id);
    assert.ok(lockPath, 'lock should be acquired');

    const result = await submitNativeRequest({
      requestId: request_id,
      lockPath,
      deps: {
        readRequest,
        updateRequest,
        submitRequest: async (request) => ({
          sentinel: `ECX_REQUEST_ID:${request.request_id}`,
          conversation_title: `ECX ${request.request_id}`,
          conversation: { localID: 'local-1' },
        }),
        writeResponseVerified,
        removeRequest,
        notifyAgentIfAvailable: async () => {},
        releaseRequestLock,
      },
    });

    assert.equal(result.state, 'generating');
    assert.equal(existsSync(lockPath), false, 'lock should be released');

    const req = await readRequest(request_id);
    assert.equal(req.state, 'generating');
    assert.equal(req.sentinel, `ECX_REQUEST_ID:${request_id}`);
    assert.equal(req.native.conversation.localID, 'local-1');
    assert.ok(req.next_probe_at, 'probe should be scheduled');
  });
});

test('submitNativeRequest writes terminal error response when native submit fails', async () => {
  await withMailboxHome(async () => {
    const { request_id } = await submit('hello', { agent: 'delta' });
    const lockPath = await claimRequestLock(request_id);
    assert.ok(lockPath, 'lock should be acquired');

    let notifyCalls = 0;
    const result = await submitNativeRequest({
      requestId: request_id,
      lockPath,
      deps: {
        readRequest,
        updateRequest,
        submitRequest: async () => {
          throw new Error('native_accessibility_permission_missing');
        },
        writeResponseVerified,
        removeRequest,
        notifyAgentIfAvailable: async () => { notifyCalls += 1; },
        releaseRequestLock,
      },
    });

    assert.equal(result.state, 'error');
    assert.equal(notifyCalls, 1);
    assert.equal(existsSync(lockPath), false, 'lock should be released');
    assert.equal(await readRequest(request_id), null);

    const fetched = await fetch(request_id);
    assert.equal(fetched.complete, true);
    assert.equal(fetched.error, 'native_accessibility_permission_missing');
  });
});

test('probeNativeRequest persists complete response and removes request', async () => {
  await withMailboxHome(async () => {
    const { request_id } = await submit('hello', { agent: 'beta' });
    await updateRequest(request_id, { state: 'generating', started_at: new Date().toISOString() });
    const lockPath = await claimRequestLock(request_id);
    assert.ok(lockPath, 'lock should be acquired');

    let notifyCalls = 0;
    const result = await probeNativeRequest({
      requestId: request_id,
      lockPath,
      deps: {
        readRequest,
        updateRequest,
        probeRequest: async () => ({ complete: true, text: 'answer', files: [] }),
        verifyResponseFiles,
        writeResponseVerified,
        removeRequest,
        notifyAgentIfAvailable: async () => { notifyCalls += 1; },
        releaseRequestLock,
      },
    });

    assert.equal(result.state, 'complete');
    assert.equal(notifyCalls, 1);
    assert.equal(existsSync(lockPath), false, 'lock should be released');
    assert.equal(await readRequest(request_id), null);

    const fetched = await fetch(request_id);
    assert.equal(fetched.complete, true);
    assert.equal(fetched.text, 'answer');
    assert.equal(fetched.error, undefined);
  });
});

test('probeNativeRequest reschedules active request when still generating', async () => {
  await withMailboxHome(async () => {
    const { request_id } = await submit('hello', { agent: 'gamma' });
    await updateRequest(request_id, {
      state: 'completion_hint',
      notification_hint_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
    });
    const lockPath = await claimRequestLock(request_id);
    assert.ok(lockPath, 'lock should be acquired');

    const result = await probeNativeRequest({
      requestId: request_id,
      lockPath,
      deps: {
        readRequest,
        updateRequest,
        probeRequest: async () => ({ complete: false, generating: true }),
        verifyResponseFiles,
        writeResponseVerified,
        removeRequest,
        notifyAgentIfAvailable: async () => {},
        releaseRequestLock,
      },
    });

    assert.equal(result.state, 'generating');
    const req = await readRequest(request_id);
    assert.equal(req.state, 'generating');
    assert.equal(req.notification_hint_at, null);
    assert.ok(req.last_notification_hint_at, 'hint should be retained historically');
    assert.ok(req.next_probe_at, 'next probe should be scheduled');
  });
});
