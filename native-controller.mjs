// Native ChatGPT macOS controller.
//
// This backend intentionally avoids Chrome/Patchright. It drives the ChatGPT
// desktop app through macOS accessibility via System Events and uses the
// private usernoted database only as an optional completion hint source.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BUNDLE_ID = 'com.openai.chat';
const APP_NAME = 'ChatGPT';
const LABEL_SEPARATOR = '\u001f';
const DEFAULT_AX_TIMEOUT_MS = Number(process.env.CHATGPT_NATIVE_AX_TIMEOUT_MS || 30_000);
const DEFAULT_SWITCH_DELAY_MS = Number(process.env.CHATGPT_NATIVE_SWITCH_DELAY_MS || 1_500);
const DEFAULT_RESPONSE_TIMEOUT_MS = Number(process.env.CHATGPT_NATIVE_RESPONSE_TIMEOUT_MS || 45 * 60_000);
const NOTIFICATION_DB = join(
  homedir(),
  'Library/Group Containers/group.com.apple.usernoted/db2/db',
);

const LABELS = {
  newChat: ['New chat', 'New Chat', '新聊天', 'Nova conversa'],
  send: ['Send', '发送', 'Enviar'],
  stop: ['Stop generating', '停止生成', 'Parar de gerar'],
  modelButton: ['ChatGPT'],
  download: ['Download', '下载', 'Transferir'],
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function flattenPrompt(input) {
  return String(input ?? '').replace(/\s+/g, ' ').trim();
}

function briefPrompt(input) {
  return flattenPrompt(input).slice(0, 90);
}

function normalizeModel(model) {
  return String(model ?? '').trim().toLowerCase();
}

function modelLabels(model) {
  const normalized = normalizeModel(model);
  if (!normalized) return [];

  if (
    normalized === 'pro'
    || normalized === 'gpt-5-pro'
    || normalized === 'gpt5-pro'
    || normalized.includes('pro')
  ) {
    return [
      'GPT-5.4 Pro',
      'GPT-5 Pro',
      'GPT-5.4',
      'GPT-5.3',
      'Pro',
      '旗舰模型',
      'Extended Pro',
    ];
  }

  if (normalized === 'gpt-5' || normalized === 'gpt5') {
    return ['GPT-5', 'GPT-5.4', 'GPT-5.3'];
  }

  return [model];
}

function labelsArg(labels) {
  return labels.filter(Boolean).join(LABEL_SEPARATOR);
}

function requestSentinel(requestId) {
  return `ECX_REQUEST_ID:${requestId}`;
}

function promptWithSentinel(request) {
  const sentinel = requestSentinel(request.request_id);
  return [
    `Request ID: ${request.request_id}`,
    `Tracking token: ${sentinel}`,
    'Keep the tracking token out of your final answer unless explicitly asked.',
    '',
    request.prompt,
  ].join('\n');
}

function promiseExecFile(file, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AX_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      env: opts.env ?? process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.on('error', reject);
  });
}

async function runOsa(actionScript, args = [], opts = {}) {
  const fullScript = `${AX_SCRIPT_LIBRARY}\n${actionScript}`;
  const osaArgs = ['-e', fullScript, ...args.map(value => String(value ?? ''))];
  const { stdout } = await promiseExecFile('/usr/bin/osascript', osaArgs, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_AX_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function runOpen(args) {
  await promiseExecFile('/usr/bin/open', args, { timeoutMs: 10_000 });
}

async function activateApp() {
  await runOpen(['-b', BUNDLE_ID]);
  await delay(300);
}

async function frontmostBundleId() {
  try {
    const out = await runOsa(`
on run argv
  tell application "System Events"
    set frontApp to first application process whose frontmost is true
    try
      return bundle identifier of frontApp
    on error
      return ""
    end try
  end tell
end run
`, [], { timeoutMs: 5_000 });
    return out || null;
  } catch {
    return null;
  }
}

async function restoreFrontmost(bundleId) {
  if (!bundleId || bundleId === BUNDLE_ID) return;
  await runOpen(['-b', bundleId]).catch(() => {});
}

async function requireAxTrusted() {
  if (await axTrusted()) return;
  throw new Error('native_accessibility_permission_missing: grant Accessibility permission before controlling ChatGPT');
}

async function withChatGPTUi(fn) {
  await requireAxTrusted();
  const previousBundleId = await frontmostBundleId();
  await activateApp();
  try {
    return await fn();
  } finally {
    await restoreFrontmost(previousBundleId);
  }
}

async function readLastSelectedConversation() {
  try {
    const { stdout } = await promiseExecFile('/usr/bin/defaults', [
      'read',
      BUNDLE_ID,
      'lastSelectedConversation',
    ], { timeoutMs: 5_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

async function axTrusted() {
  try {
    const { stdout } = await promiseExecFile('/usr/bin/osascript', [
      '-e',
      'tell application "System Events" to return UI elements enabled',
    ], { timeoutMs: 5_000, maxBuffer: 128 * 1024 });
    return stdout.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

async function chatgptPid() {
  try {
    const { stdout } = await promiseExecFile('/usr/bin/pgrep', ['-x', APP_NAME], { timeoutMs: 5_000 });
    return Number(stdout.trim().split(/\s+/)[0]) || null;
  } catch {
    return null;
  }
}

export async function launch() {
  await activateApp();
  return { state: 'launched' };
}

export async function status() {
  const pid = await chatgptPid();
  const trusted = await axTrusted();
  if (!pid) {
    return { state: 'not_running', backend: 'native', ax_trusted: trusted, pid: null };
  }
  return {
    state: trusted ? 'ready' : 'needs_accessibility_permission',
    backend: 'native',
    ax_trusted: trusted,
    pid,
  };
}

async function maybeSetModel(model) {
  const labels = modelLabels(model);
  if (!labels.length) return { model: null, changed: false };

  const out = await runOsa(`
on run argv
  my ensureChatGPT()
  set buttonLabels to my splitLabels(item 1 of argv)
  set modelLabels to my splitLabels(item 2 of argv)
  tell application "System Events"
    tell process "${APP_NAME}"
      set modelButton to my findButton(window 1, buttonLabels)
      if modelButton is missing value then return "model_button_missing"
      click modelButton
      delay 0.5
      set targetButton to my findButton(window 1, modelLabels)
      if targetButton is missing value then
        my pressEscape()
        return "model_missing"
      end if
      click targetButton
      delay 0.4
      return "model_selected"
    end tell
  end tell
end run
`, [labelsArg(LABELS.modelButton), labelsArg(labels)], { timeoutMs: 12_000 });

  if (out !== 'model_selected' && process.env.CHATGPT_NATIVE_REQUIRE_MODEL === '1') {
    throw new Error(`native_model_selection_failed:${out}:${model}`);
  }
  return { model, changed: out === 'model_selected', detail: out };
}

async function submitPrompt(request) {
  const fullPrompt = promptWithSentinel(request);
  const model = request.model ?? null;
  const modelResult = model ? await maybeSetModel(model) : { model: null, changed: false };

  const out = await runOsa(`
on run argv
  set promptText to item 1 of argv
  set freshMode to item 2 of argv
  set sendLabels to my splitLabels(item 3 of argv)
  set newChatLabels to my splitLabels(item 4 of argv)

  my ensureChatGPT()

  tell application "System Events"
    tell process "${APP_NAME}"
      if freshMode is "1" then
        key code 45 using {command down}
        delay 0.8
        set newChatButton to my findButton(window 1, newChatLabels)
        if newChatButton is not missing value then
          try
            click newChatButton
            delay 0.4
          end try
        end if
      end if

      set inputArea to my firstTextArea(window 1)
      if inputArea is missing value then error "composer_text_area_missing"
      try
        set focused of inputArea to true
      end try
      set value of inputArea to promptText
      delay 0.2

      set sendButton to my findButton(window 1, sendLabels)
      if sendButton is not missing value then
        click sendButton
      else
        key code 36
      end if
      delay 0.7
      return "submitted"
    end tell
  end tell
end run
`, [
    fullPrompt,
    request.fresh === false ? '0' : '1',
    labelsArg(LABELS.send),
    labelsArg(LABELS.newChat),
  ], { timeoutMs: 45_000 });

  const selectedConversation = await readLastSelectedConversation();
  return {
    submitted: out === 'submitted',
    model_result: modelResult,
    conversation: selectedConversation,
    sentinel: requestSentinel(request.request_id),
  };
}

async function switchToRequestConversation(request) {
  const targetUrl = request.notification_target_url
    || request.conversation_url
    || request.target_url
    || null;

  if (targetUrl) {
    await runOpen([targetUrl]);
    await delay(DEFAULT_SWITCH_DELAY_MS);
    return { method: 'url', target_url: targetUrl };
  }

  const searchText = request.sentinel || requestSentinel(request.request_id);
  const out = await runOsa(`
on run argv
  set searchText to item 1 of argv
  my ensureChatGPT()
  tell application "System Events"
    tell process "${APP_NAME}"
      key code 40 using {command down}
      delay 0.4
      keystroke searchText
      delay 0.7
      key code 36
      delay 1.0
      return "searched"
    end tell
  end tell
end run
`, [searchText], { timeoutMs: 12_000 }).catch(error => {
    return `search_failed:${error.message || error}`;
  });
  return { method: 'search', detail: out };
}

async function hasStopButton() {
  const out = await runOsa(`
on run argv
  set stopLabels to my splitLabels(item 1 of argv)
  my ensureChatGPT()
  tell application "System Events"
    tell process "${APP_NAME}"
      set stopButton to my findButton(window 1, stopLabels)
      if stopButton is missing value then return "0"
      return "1"
    end tell
  end tell
end run
`, [labelsArg(LABELS.stop)], { timeoutMs: 10_000 });
  return out === '1';
}

async function readVisibleText() {
  return runOsa(`
on run argv
  my ensureChatGPT()
  tell application "System Events"
    tell process "${APP_NAME}"
      return my collectTexts(window 1)
    end tell
  end tell
end run
`, [], { timeoutMs: 45_000, maxBuffer: 32 * 1024 * 1024 });
}

function extractAssistantText(rawText, request) {
  const prompt = String(request.prompt ?? '').trim();
  const sentinel = request.sentinel || requestSentinel(request.request_id);
  let text = String(rawText ?? '');

  for (const needle of [
    prompt,
    `Request ID: ${request.request_id}`,
    `Tracking token: ${sentinel}`,
    'Keep the tracking token out of your final answer unless explicitly asked.',
    sentinel,
    request.request_id,
  ]) {
    if (needle) text = text.split(needle).join('');
  }

  const ignored = new Set([
    'ChatGPT',
    'New chat',
    'Send',
    'Stop generating',
    'Search',
    'Attach',
    'Voice',
    'Explore GPTs',
    'Library',
    'Today',
    'Yesterday',
    '新聊天',
    '发送',
    '停止生成',
    '搜索',
  ]);

  const lines = text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line && !ignored.has(line));

  const cleaned = lines.join('\n\n').trim();
  return cleaned || String(rawText ?? '').trim();
}

async function collectDownloadedImagesSince(startedAt, outputDir) {
  if (!outputDir) return [];
  await mkdir(outputDir, { recursive: true });
  const names = await readdir(outputDir).catch(() => []);
  const startMs = Date.parse(startedAt || '') || 0;
  const files = [];

  for (const name of names) {
    const path = join(outputDir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (startMs && info.mtimeMs + 2_000 < startMs) continue;
    if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(name)) continue;
    files.push(path);
  }

  return files.sort();
}

async function clickDownloadButtons() {
  await runOsa(`
on run argv
  set downloadLabels to my splitLabels(item 1 of argv)
  my ensureChatGPT()
  tell application "System Events"
    tell process "${APP_NAME}"
      set clickedCount to 0
      set elems to entire contents of window 1
      repeat with itemRef in elems
        try
          set roleText to role of itemRef as text
          if (roleText is "AXButton" or roleText is "button") and my matchesAnyText(itemRef, downloadLabels) then
            click itemRef
            set clickedCount to clickedCount + 1
            delay 0.2
          end if
        end try
      end repeat
      return clickedCount as text
    end tell
  end tell
end run
`, [labelsArg(LABELS.download)], { timeoutMs: 15_000 }).catch(() => '0');
}

export async function submitRequest(request) {
  return withChatGPTUi(async () => {
    const started = await submitPrompt(request);
    return {
      ...started,
      conversation_title: `ECX ${request.request_id} ${briefPrompt(request.prompt)}`.trim(),
      conversation_url: null,
    };
  });
}

export async function probeRequest(request) {
  return withChatGPTUi(async () => {
    const switchResult = await switchToRequestConversation(request);
    const generating = await hasStopButton();
    if (generating) {
      return {
        complete: false,
        generating: true,
        switch_result: switchResult,
      };
    }

    const rawText = await readVisibleText();
    const text = extractAssistantText(rawText, request);
    const hasText = Boolean(text.trim());
    let files = [];

    if ((request.mode || 'text') === 'image') {
      await clickDownloadButtons();
      files = await collectDownloadedImagesSince(
        request.started_at || request.created_at,
        request.image_dir || request.output_dir,
      );
    }

    return {
      complete: hasText || files.length > 0 || Boolean(request.notification_hint_at),
      generating: false,
      text,
      raw_text: rawText,
      files,
      switch_result: switchResult,
    };
  });
}

async function waitForCurrentCompletion(request, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
  let lastProbe = null;
  while (Date.now() < deadline) {
    lastProbe = await probeRequest(request);
    if (lastProbe.complete) return lastProbe;
    await delay(Number(opts.pollMs ?? 2_000));
  }
  throw new Error(`native_response_timeout:${request.request_id}`);
}

export async function query(prompt, opts = {}) {
  const request = {
    request_id: `sync-${Date.now()}`,
    prompt,
    model: opts.model ?? null,
    thinking: opts.thinking ?? null,
    fresh: opts.fresh ?? true,
    mode: opts.mode ?? 'text',
    output_dir: opts.output_dir ?? null,
    image_dir: opts.image_dir ?? null,
    created_at: nowIso(),
  };
  await submitRequest(request);
  const result = await waitForCurrentCompletion({
    ...request,
    sentinel: requestSentinel(request.request_id),
  }, opts);
  return { text: result.text ?? '', files: result.files ?? [], key: 'native' };
}

export async function generateImage(prompt, opts = {}) {
  return query(prompt, { ...opts, mode: 'image', fresh: opts.fresh ?? true });
}

export async function readLast() {
  return withChatGPTUi(async () => {
    const rawText = await readVisibleText();
    return { text: rawText, key: 'native' };
  });
}

export async function newChat() {
  await withChatGPTUi(async () => {
    await runOsa(`
on run argv
  my ensureChatGPT()
  tell application "System Events"
    tell process "${APP_NAME}"
      key code 45 using {command down}
      delay 0.4
      return "ok"
    end tell
  end tell
end run
`);
  });
  return { key: 'native' };
}

export async function stop() {
  const out = await withChatGPTUi(() => runOsa(`
on run argv
  set stopLabels to my splitLabels(item 1 of argv)
  my ensureChatGPT()
  tell application "System Events"
    tell process "${APP_NAME}"
      set stopButton to my findButton(window 1, stopLabels)
      if stopButton is missing value then return "not_generating"
      click stopButton
      return "stopped"
    end tell
  end tell
end run
`, [labelsArg(LABELS.stop)]));
  return { stopped: out === 'stopped', detail: out };
}

export async function getModel() {
  const conversation = await readLastSelectedConversation();
  return conversation?.modelSlug ?? null;
}

export async function setModel(name) {
  return withChatGPTUi(() => maybeSetModel(name));
}

export async function getThinking() {
  return null;
}

export async function setThinking(level) {
  return { level, changed: false, detail: 'native_thinking_control_not_available' };
}

export async function checkSelectors() {
  const s = await status();
  return [
    { path: 'native.ax_trusted', selector: 'System Events accessibility permission', count: s.ax_trusted ? 1 : 0 },
    { path: 'native.chatgpt_process', selector: BUNDLE_ID, count: s.pid ? 1 : 0 },
    { path: 'native.notifications_db', selector: NOTIFICATION_DB, count: existsSync(NOTIFICATION_DB) ? 1 : 0 },
  ];
}

export async function shutdown() {
  // No persistent native resources.
}

function printableStrings(buffer) {
  const raw = buffer.toString('latin1');
  const matches = raw.match(/[ -~]{3,}/g) || [];
  return matches.map(value => value.trim()).filter(Boolean);
}

function extractTargetUrl(strings) {
  const joined = strings.join('\n');
  const match = joined.match(/\b(?:chatgpt|openai):\/\/[^\s"'<>]+|\bhttps:\/\/(?:chatgpt\.com|chat\.openai\.com)\/[^\s"'<>]+/i);
  return match?.[0] ?? null;
}

function notificationMatchesRequest(strings, request) {
  const haystack = strings.join('\n');
  const needles = [
    request.request_id,
    request.sentinel,
    requestSentinel(request.request_id),
    request.conversation_title,
  ].filter(Boolean);
  return needles.some(needle => haystack.includes(needle));
}

async function sqliteQuery(sql) {
  if (!existsSync(NOTIFICATION_DB)) {
    return '';
  }
  const { stdout } = await promiseExecFile('/usr/bin/sqlite3', [
    '-readonly',
    '-separator',
    '\t',
    NOTIFICATION_DB,
    sql,
  ], { timeoutMs: 5_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function currentNotificationRecordId() {
  try {
    const raw = await sqliteQuery(`
SELECT COALESCE(MAX(r.rec_id), 0)
FROM record r JOIN app a USING(app_id)
WHERE lower(a.identifier) IN ('com.openai.chat', 'com.openai.chatgpt');
`);
    return Number(raw.trim()) || 0;
  } catch {
    return 0;
  }
}

export async function scanNotifications(requests = [], sinceRecordId = 0) {
  if (!requests.length) {
    return { lastRecordId: sinceRecordId, hints: [] };
  }

  const rowsRaw = await sqliteQuery(`
SELECT r.rec_id, COALESCE(r.delivered_date, r.request_date, 0), hex(r.data)
FROM record r JOIN app a USING(app_id)
WHERE lower(a.identifier) IN ('com.openai.chat', 'com.openai.chatgpt')
  AND r.rec_id > ${Number(sinceRecordId) || 0}
ORDER BY r.rec_id ASC;
`).catch(() => '');

  const hints = [];
  let lastRecordId = Number(sinceRecordId) || 0;
  const requestsById = new Map(requests.map(request => [request.request_id, request]));

  for (const line of rowsRaw.split('\n')) {
    if (!line.trim()) continue;
    const [recIdRaw, deliveredRaw, hex] = line.split('\t');
    const recId = Number(recIdRaw) || 0;
    if (recId > lastRecordId) lastRecordId = recId;
    if (!hex) continue;

    const strings = printableStrings(Buffer.from(hex, 'hex'));
    const targetUrl = extractTargetUrl(strings);
    for (const request of requestsById.values()) {
      if (!notificationMatchesRequest(strings, request)) continue;
      hints.push({
        request_id: request.request_id,
        record_id: recId,
        delivered_date: Number(deliveredRaw) || null,
        target_url: targetUrl,
        title_or_body: strings.slice(-8).join(' '),
      });
    }
  }

  return { lastRecordId, hints };
}

export function notificationDbPath() {
  return NOTIFICATION_DB;
}

const AX_SCRIPT_LIBRARY = `
on splitLabels(rawText)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to "${LABEL_SEPARATOR}"
  set xs to text items of rawText
  set AppleScript's text item delimiters to oldDelimiters
  return xs
end splitLabels

on ensureChatGPT()
  tell application id "${BUNDLE_ID}" to activate
  delay 0.25
  tell application "System Events"
    tell process "${APP_NAME}"
      set frontmost to true
    end tell
  end tell
end ensureChatGPT

on pressEscape()
  tell application "System Events" to key code 53
end pressEscape

on elementTextCandidates(itemRef)
  set xs to {}
  try
    set d to description of itemRef as text
    if d is not "" then set end of xs to d
  end try
  try
    set t to title of itemRef as text
    if t is not "" then set end of xs to t
  end try
  try
    set n to name of itemRef as text
    if n is not "" then set end of xs to n
  end try
  try
    set v to value of itemRef as text
    if v is not "" then set end of xs to v
  end try
  try
    set h to help of itemRef as text
    if h is not "" then set end of xs to h
  end try
  return xs
end elementTextCandidates

on matchesAnyText(itemRef, labels)
  set candidates to my elementTextCandidates(itemRef)
  repeat with labelRef in labels
    set labelText to labelRef as text
    if labelText is not "" then
      repeat with candidateRef in candidates
        set candidateText to candidateRef as text
        if candidateText is labelText then return true
        if candidateText contains labelText then return true
      end repeat
    end if
  end repeat
  return false
end matchesAnyText

on findButton(rootRef, labels)
  set elems to entire contents of rootRef
  repeat with itemRef in elems
    try
      set roleText to role of itemRef as text
      if roleText is "AXButton" or roleText is "button" then
        if my matchesAnyText(itemRef, labels) then return itemRef
      end if
    end try
  end repeat
  return missing value
end findButton

on firstTextArea(rootRef)
  set elems to entire contents of rootRef
  repeat with itemRef in elems
    try
      set roleText to role of itemRef as text
      if roleText is "AXTextArea" or roleText is "text area" then return itemRef
    end try
  end repeat
  return missing value
end firstTextArea

on collectTexts(rootRef)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed & linefeed
  set texts to {}
  set elems to entire contents of rootRef
  repeat with itemRef in elems
    try
      set roleText to role of itemRef as text
      if roleText is "AXStaticText" or roleText is "static text" or roleText is "AXTextArea" or roleText is "text area" then
        set candidates to my elementTextCandidates(itemRef)
        repeat with candidateRef in candidates
          set candidateText to candidateRef as text
          if length of candidateText > 2 then set end of texts to candidateText
        end repeat
      end if
    end try
  end repeat
  set joinedText to texts as text
  set AppleScript's text item delimiters to oldDelimiters
  return joinedText
end collectTexts
`;
