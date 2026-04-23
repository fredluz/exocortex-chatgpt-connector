function nowIso() {
  return new Date().toISOString();
}

function elapsedMs(createdAt, finishedAt = null) {
  const start = Date.parse(createdAt || '');
  if (Number.isNaN(start)) return 0;
  const end = Date.parse(finishedAt || '') || Date.now();
  return Math.max(0, end - start);
}

function briefPrompt(prompt) {
  const text = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 220);
}

function nextProbeDelayMs(request, result = null) {
  if (result?.generating === false && request.notification_hint_at) return 1_000;
  if ((request.mode || 'text') === 'image') return Number(process.env.CHATGPT_NATIVE_IMAGE_PROBE_MS || 30_000);
  const model = String(request.model || '').toLowerCase();
  if (model.includes('pro')) return Number(process.env.CHATGPT_NATIVE_PRO_PROBE_MS || 20_000);
  return Number(process.env.CHATGPT_NATIVE_TEXT_PROBE_MS || 8_000);
}

function dueAt(delayMs) {
  return new Date(Date.now() + Math.max(0, Number(delayMs) || 0)).toISOString();
}

function errorMessage(error) {
  return String(error?.message || error || 'unknown_error');
}

function responseBase(requestId, request, state, extra = {}) {
  const finishedAt = nowIso();
  return {
    request_id: requestId,
    state,
    agent: request?.agent ?? '_default',
    response_path: request?.response_path ?? null,
    text: '',
    files: [],
    mode: request?.mode ?? 'text',
    image_dir: request?.mode === 'image' ? (request?.image_dir ?? request?.output_dir ?? null) : null,
    created_at: request?.created_at ?? finishedAt,
    started_at: request?.started_at ?? request?.created_at ?? finishedAt,
    finished_at: finishedAt,
    elapsed_ms: elapsedMs(request?.created_at, finishedAt),
    ...extra,
  };
}

export async function submitNativeRequest(input) {
  const {
    requestId,
    lockPath,
    deps,
  } = input;

  const {
    readRequest,
    updateRequest,
    submitRequest,
    writeResponseVerified,
    removeRequest,
    notifyAgentIfAvailable,
    releaseRequestLock,
  } = deps;

  try {
    const request = await readRequest(requestId);
    if (!request) return { state: 'missing' };

    const submitting = await updateRequest(requestId, {
      state: 'submitting',
      started_at: request.started_at ?? nowIso(),
      submit_attempts: Number(request.submit_attempts || 0) + 1,
    });

    const submitResult = await submitRequest(submitting);
    const generating = await updateRequest(requestId, {
      state: 'generating',
      native: submitResult,
      sentinel: submitResult?.sentinel ?? request.sentinel,
      conversation: submitResult?.conversation ?? request.conversation ?? null,
      conversation_title: submitResult?.conversation_title ?? request.conversation_title ?? null,
      conversation_url: submitResult?.conversation_url ?? request.conversation_url ?? null,
      last_probe_at: null,
      next_probe_at: dueAt(nextProbeDelayMs(submitting)),
      probe_error_count: 0,
    });

    return { state: 'generating', request: generating };
  } catch (error) {
    const request = await readRequest(requestId).catch(() => null);
    const message = errorMessage(error);

    if (request) {
      const response = responseBase(requestId, request, 'error', {
        error: message,
      });
      await writeResponseVerified(requestId, response).catch(() => {});
      await removeRequest(requestId).catch(() => {});
      await notifyAgentIfAvailable(request.agent, requestId, message, {
        responsePath: request.response_path ?? undefined,
        requestBrief: briefPrompt(request.prompt),
      }).catch(() => {});
      return { state: 'error', error: message, response };
    }

    return { state: 'error', error: message, request };
  } finally {
    await releaseRequestLock(lockPath).catch(() => {});
  }
}

export async function probeNativeRequest(input) {
  const {
    requestId,
    lockPath,
    deps,
  } = input;

  const {
    readRequest,
    updateRequest,
    probeRequest,
    verifyResponseFiles,
    writeResponseVerified,
    removeRequest,
    notifyAgentIfAvailable,
    releaseRequestLock,
  } = deps;

  try {
    const request = await readRequest(requestId);
    if (!request) return { state: 'missing' };

    await updateRequest(requestId, {
      state: 'probing',
      last_probe_at: nowIso(),
    });

    const result = await probeRequest(request);
    if (!result?.complete) {
      const updated = await updateRequest(requestId, {
        state: 'generating',
        generating: Boolean(result?.generating),
        last_notification_hint_at: request.notification_hint_at ?? request.last_notification_hint_at ?? null,
        notification_hint_at: null,
        next_probe_at: dueAt(nextProbeDelayMs(request, result)),
        probe_error_count: 0,
        last_probe_result: {
          generating: Boolean(result?.generating),
          switch_result: result?.switch_result ?? null,
        },
      });
      return { state: 'generating', request: updated };
    }

    const response = responseBase(requestId, request, 'complete', {
      text: result.text ?? '',
      files: Array.isArray(result.files) ? result.files : [],
      raw_text: result.raw_text ?? undefined,
    });

    await verifyResponseFiles(response.files);
    await writeResponseVerified(requestId, response);
    await removeRequest(requestId);
    await notifyAgentIfAvailable(request.agent, requestId, response.text, {
      responsePath: request.response_path ?? undefined,
      imageDir: response.image_dir,
      fileCount: response.files.length,
      requestBrief: briefPrompt(request.prompt),
    });

    return { state: 'complete', response };
  } catch (error) {
    const request = await readRequest(requestId).catch(() => null);
    if (!request) return { state: 'missing' };

    const count = Number(request.probe_error_count || 0) + 1;
    const max = Number(process.env.CHATGPT_NATIVE_MAX_PROBE_ERRORS || 5);
    const message = errorMessage(error);

    if (count < max) {
      const updated = await updateRequest(requestId, {
        state: 'generating',
        probe_error_count: count,
        error: message,
        next_probe_at: dueAt(Number(process.env.CHATGPT_NATIVE_PROBE_RETRY_MS || 15_000)),
      });
      return { state: 'retry', error: message, request: updated };
    }

    const response = responseBase(requestId, request, 'error', {
      error: message,
    });
    await writeResponseVerified(requestId, response).catch(() => {});
    await removeRequest(requestId).catch(() => {});
    await notifyAgentIfAvailable(request.agent, requestId, message, {
      responsePath: request.response_path ?? undefined,
      requestBrief: briefPrompt(request.prompt),
    }).catch(() => {});
    return { state: 'error', error: message, response };
  } finally {
    await releaseRequestLock(lockPath).catch(() => {});
  }
}
