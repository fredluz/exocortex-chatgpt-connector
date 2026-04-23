#!/usr/bin/env node

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  claimRequestLock,
  listRequestIds,
  normalizeAgent,
  readRequest,
  releaseRequestLock,
  removeDaemonPid,
  removeRequest,
  verifyResponseFiles,
  writeDaemonPid,
  writeResponseVerified,
  updateRequest,
  notifyAgentIfAvailable,
} from './mailbox.mjs';
import {
  currentNotificationRecordId,
  probeRequest,
  scanNotifications,
  shutdown,
  status as nativeStatus,
  submitRequest,
} from './native-controller.mjs';
import {
  probeNativeRequest,
  submitNativeRequest,
} from './daemon-core.mjs';

const POLL_MS = Number(process.env.CHATGPT_MCP_DAEMON_POLL_MS || 250);
const MAX_ACTIVE_GENERATIONS = Number(process.env.CHATGPT_NATIVE_MAX_ACTIVE || 3);
const ROUTE_RESPONSE_SCRIPT = join(homedir(), '.clawd', 'bin', 'route-response.sh');

let stopping = false;
let pidClaimed = false;
let lastNotificationRecordId = 0;

function requestStop() {
  stopping = true;
}

process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);

function parseTime(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

function isPending(request) {
  const state = request?.state ?? 'pending';
  return state === 'pending';
}

function isActive(request) {
  const state = request?.state ?? 'pending';
  return state === 'generating' || state === 'probing' || state === 'completion_hint';
}

function isDue(request) {
  if (request?.notification_hint_at) return true;
  const due = parseTime(request?.next_probe_at);
  return !due || due <= Date.now();
}

async function readAllRequests() {
  const requestIds = await listRequestIds();
  const rows = [];
  for (const requestId of requestIds) {
    const request = await readRequest(requestId);
    if (!request) continue;

    const state = request.state ?? 'pending';
    if (state === 'complete' || state === 'error') {
      await removeRequest(requestId).catch(() => {});
      continue;
    }

    rows.push({ requestId, request });
  }
  return rows;
}

async function applyNotificationHints(activeRows) {
  if (!activeRows.length) return 0;

  const { lastRecordId, hints } = await scanNotifications(
    activeRows.map(row => row.request),
    lastNotificationRecordId,
  );
  lastNotificationRecordId = Math.max(lastNotificationRecordId, lastRecordId);

  let applied = 0;
  for (const hint of hints) {
    const lockPath = await claimRequestLock(hint.request_id);
    if (!lockPath) continue;
    try {
      const request = await readRequest(hint.request_id);
      if (!request || !isActive(request)) continue;
      await updateRequest(hint.request_id, {
        state: 'completion_hint',
        notification_hint_at: new Date().toISOString(),
        notification_record_id: hint.record_id,
        notification_target_url: hint.target_url ?? request.notification_target_url ?? null,
        next_probe_at: new Date().toISOString(),
      });
      applied += 1;
    } finally {
      await releaseRequestLock(lockPath).catch(() => {});
    }
  }
  return applied;
}

async function runSubmit(row) {
  const lockPath = await claimRequestLock(row.requestId);
  if (!lockPath) return false;

  const result = await submitNativeRequest({
    requestId: row.requestId,
    lockPath,
    deps: {
      readRequest,
      updateRequest,
      submitRequest,
      writeResponseVerified,
      removeRequest,
      notifyAgentIfAvailable: (notifyAgent, notifyRequestId, notifyPreview, notifyOptions = {}) => {
        return notifyAgentIfAvailable(normalizeAgent(notifyAgent), notifyRequestId, notifyPreview, {
          ...notifyOptions,
          scriptPath: ROUTE_RESPONSE_SCRIPT,
          useResponseRouter: true,
        });
      },
      releaseRequestLock,
    },
  });

  if (result.state === 'error') {
    console.error('[daemon] submit failed', row.requestId, result.error);
  }
  return true;
}

async function runProbe(row) {
  const lockPath = await claimRequestLock(row.requestId);
  if (!lockPath) return false;

  const result = await probeNativeRequest({
    requestId: row.requestId,
    lockPath,
    deps: {
      readRequest,
      updateRequest,
      probeRequest,
      verifyResponseFiles,
      writeResponseVerified,
      removeRequest,
      notifyAgentIfAvailable: (notifyAgent, notifyRequestId, notifyPreview, notifyOptions = {}) => {
        return notifyAgentIfAvailable(normalizeAgent(notifyAgent), notifyRequestId, notifyPreview, {
          ...notifyOptions,
          scriptPath: ROUTE_RESPONSE_SCRIPT,
          useResponseRouter: true,
        });
      },
      releaseRequestLock,
    },
  });

  if (result.state === 'complete') {
    console.error('[daemon] complete', row.requestId);
  } else if (result.state === 'error') {
    console.error('[daemon] error', row.requestId, result.error);
  }
  return true;
}

async function maybeWork() {
  const rows = await readAllRequests();
  const activeRows = rows.filter(row => isActive(row.request));
  await applyNotificationHints(activeRows);

  const refreshedRows = await readAllRequests();
  const activeCount = refreshedRows.filter(row => isActive(row.request)).length;

  if (activeCount < MAX_ACTIVE_GENERATIONS) {
    const pending = refreshedRows
      .filter(row => isPending(row.request))
      .sort((a, b) => parseTime(a.request.created_at) - parseTime(b.request.created_at));

    if (pending.length) {
      return await runSubmit(pending[0]);
    }
  }

  const dueActive = refreshedRows
    .filter(row => isActive(row.request) && isDue(row.request))
    .sort((a, b) => {
      const ah = a.request.notification_hint_at ? 0 : 1;
      const bh = b.request.notification_hint_at ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return parseTime(a.request.next_probe_at) - parseTime(b.request.next_probe_at);
    });

  if (dueActive.length) {
    return await runProbe(dueActive[0]);
  }

  return false;
}

try {
  pidClaimed = await writeDaemonPid(process.pid, { exclusive: true });
  if (!pidClaimed) {
    console.error('[daemon] already running; exiting duplicate worker');
    process.exit(0);
  }

  const s = await nativeStatus();
  if (!s.ax_trusted) {
    console.error('[daemon] native Accessibility permission missing; refusing to control ChatGPT');
    process.exit(1);
  }

  lastNotificationRecordId = await currentNotificationRecordId();
  console.error('[daemon] native ChatGPT mailbox worker running');

  while (!stopping) {
    const worked = await maybeWork();
    if (!worked) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
} finally {
  if (pidClaimed) {
    await removeDaemonPid().catch(() => {});
  }
  await shutdown();
}
