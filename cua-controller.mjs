// cua-controller.mjs
// ChatGPT desktop transport powered by cua-driver (no browser automation).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parsePillText } from './parse-pill.mjs';
import { getImagesDir } from './runtime-paths.mjs';
export { parsePillText };

const CUA_BIN = process.env.CHATGPT_CUA_DRIVER || '/usr/local/bin/cua-driver';
const APP_BUNDLE_ID = 'com.openai.chat';
const IMAGE_ROOT_DIR = getImagesDir();
const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const TEXT_RESPONSE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = Number(process.env.CHATGPT_CUA_POLL_MS || 1200);

let _session = null;

const _ephemeral = new Map();

let _chain = Promise.resolve();
function serialize(fn) {
  const next = _chain.then(fn, fn);
  _chain = next.catch(() => {});
  return next;
}

function log(...a) {
  console.error('[cua-controller]', ...a);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeLc(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function slugifyPrompt(prompt) {
  const slug = String(prompt ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'image';
}

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function resolveOutputDir(prompt, outputDir) {
  if (outputDir) {
    const dir = isAbsolute(outputDir) ? outputDir : resolve(process.cwd(), outputDir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = join(IMAGE_ROOT_DIR, `${formatTimestamp(new Date())}-${slugifyPrompt(prompt)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function execFileAsync(file, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, {
      timeout: opts.timeoutMs ?? 90_000,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function renderCallError(error, context = '') {
  const parts = [context, error?.message, error?.stdout, error?.stderr]
    .map(part => normalizeWhitespace(part))
    .filter(Boolean);
  return parts.join(' | ');
}

async function callCua(tool, payload = null, opts = {}) {
  if (!existsSync(CUA_BIN)) {
    throw new Error(`cua_driver_missing:${CUA_BIN}`);
  }

  const args = ['call', tool];
  if (payload && Object.keys(payload).length > 0) {
    args.push(JSON.stringify(payload));
  }
  args.push('--compact');
  if (opts.imageOut) {
    args.push('--image-out', opts.imageOut);
  }

  try {
    const { stdout } = await execFileAsync(CUA_BIN, args, {
      timeoutMs: opts.timeoutMs ?? 120_000,
      maxBuffer: opts.maxBuffer,
    });
    return String(stdout || '').trim();
  } catch (error) {
    throw new Error(renderCallError(error, `cua_call_failed:${tool}`));
  }
}

function parsePid(text) {
  const match = String(text || '').match(/\bpid\s*(?:[:=]\s*|\s+)(\d+)\b/i) || String(text || '').match(/\(pid\s+(\d+)\)/i);
  return match ? Number(match[1]) : null;
}

function parseWindowCandidates(text, preferredPid = null) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('window_id')) continue;
    const idMatch = line.match(/\[window_id:\s*(\d+)\]/i);
    if (!idMatch) continue;

    const pidMatch = line.match(/\(pid\s+(\d+)\)/i);
    const titleMatch = line.match(/"([^"]+)"/);

    rows.push({
      line,
      windowId: Number(idMatch[1]),
      pid: pidMatch ? Number(pidMatch[1]) : null,
      title: titleMatch ? titleMatch[1] : '',
      offScreen: /\[off-screen\]/i.test(line),
    });
  }

  if (Number.isInteger(preferredPid)) {
    const filtered = rows.filter(row => row.pid == null || row.pid === preferredPid);
    if (filtered.length) return filtered;
  }
  return rows;
}

function pickWindowId(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const titledOnScreen = candidates.find(row => !row.offScreen && row.title);
  if (titledOnScreen) return titledOnScreen.windowId;

  const onScreen = candidates.find(row => !row.offScreen);
  if (onScreen) return onScreen.windowId;

  const titled = candidates.find(row => row.title);
  if (titled) return titled.windowId;

  return candidates[candidates.length - 1].windowId;
}

async function refreshWindowIdForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const listing = await callCua('list_windows', { pid });
  const candidates = parseWindowCandidates(listing, pid);
  return pickWindowId(candidates);
}

async function launchSession() {
  const out = await callCua('launch_app', { bundle_id: APP_BUNDLE_ID });
  const pid = parsePid(out);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`launch_app_unparseable:${out.slice(0, 280)}`);
  }

  const launchWindows = parseWindowCandidates(out, pid);
  let windowId = pickWindowId(launchWindows);

  if (!windowId) {
    for (let i = 0; i < 15; i++) {
      windowId = await refreshWindowIdForPid(pid);
      if (windowId) break;
      await delay(250);
    }
  }

  if (!windowId) {
    throw new Error(`chatgpt_window_not_found:pid=${pid}`);
  }

  _session = { pid, windowId, launchedAt: nowIso() };
  return _session;
}

async function ensureSession() {
  if (_session?.pid && _session?.windowId) {
    return _session;
  }
  return launchSession();
}

function isWindowErrorMessage(message) {
  const text = normalizeLc(message);
  return text.includes('window_id')
    || text.includes('on the user\'s current space')
    || text.includes('invalid window')
    || text.includes('target pid')
    || text.includes('no such process');
}

function parseIndexedElements(markdown) {
  const elements = [];

  for (const rawLine of String(markdown || '').split('\n')) {
    const line = rawLine.trimEnd();
    const idxMatch = line.match(/\[(\d+)\]\s+(AX[\w]+)/);
    if (!idxMatch) continue;

    const index = Number(idxMatch[1]);
    const role = idxMatch[2];
    const valueMatch = line.match(/=\s*"([^"]*)"/);
    const nameMatch = line.match(/\]\s+AX[\w]+\s+"([^"]*)"/);
    const labelMatch = line.match(/AX[\w]+(?:\s*=\s*"[^"]*"|\s+"[^"]*")?\s+\(([^)]*)\)/);
    const actionsMatch = line.match(/\bactions=\[([^\]]*)\]/);

    elements.push({
      index,
      role,
      line,
      disabled: /\bDISABLED\b/.test(line),
      value: valueMatch ? valueMatch[1] : '',
      name: nameMatch ? nameMatch[1] : '',
      label: labelMatch ? labelMatch[1] : '',
      help: (line.match(/help="([^"]*)"/) || [])[1] || '',
      id: (line.match(/\bid=([^\s]+)/) || [])[1] || '',
      actions: actionsMatch
        ? actionsMatch[1].split(',').map(value => normalizeWhitespace(value)).filter(Boolean)
        : [],
      frame: parseElementFrame(line),
    });
  }

  return elements;
}

function parseElementFrame(line) {
  const text = String(line || '');
  const number = '(-?\\d+(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`\\b(?:frame|bounds)\\s*=\\s*\\{\\{\\s*${number}\\s*,\\s*${number}\\s*\\}\\s*,\\s*\\{\\s*${number}\\s*,\\s*${number}\\s*\\}\\s*\\}`, 'i'),
    new RegExp(`\\b(?:frame|bounds)\\s*=\\s*\\(?\\s*x\\s*[:=]\\s*${number}\\s*,?\\s*y\\s*[:=]\\s*${number}\\s*,?\\s*(?:w|width)\\s*[:=]\\s*${number}\\s*,?\\s*(?:h|height)\\s*[:=]\\s*${number}`, 'i'),
    new RegExp(`\\b(?:frame|bounds)\\s*=\\s*\\(?\\s*${number}\\s*,\\s*${number}\\s*,\\s*${number}\\s*,\\s*${number}\\s*\\)?`, 'i'),
    new RegExp(`\\bposition\\s*=\\s*\\(?\\s*${number}\\s*,\\s*${number}\\s*\\)?\\s+\\bsize\\s*=\\s*\\(?\\s*${number}\\s*,\\s*${number}\\s*\\)?`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const [x, y, width, height] = match.slice(1, 5).map(Number);
    if ([x, y, width, height].every(Number.isFinite)) {
      return { x, y, width, height };
    }
  }
  return null;
}

function parseStaticTextLines(markdown) {
  const lines = [];
  for (const rawLine of String(markdown || '').split('\n')) {
    if (!rawLine.includes('AXStaticText')) continue;

    const eqMatch = rawLine.match(/AXStaticText\s*=\s*"([^"]*)"/);
    const parenMatch = rawLine.match(/AXStaticText(?:\s*=\s*"[^"]*")?\s*\(([^)]*)\)/);

    const value = normalizeWhitespace(eqMatch?.[1] ?? parenMatch?.[1] ?? '');
    if (!value) continue;

    lines.push(value);
  }
  return lines;
}

function staticSignature(lines) {
  return lines.map(value => normalizeWhitespace(value)).join('\n');
}

function isLikelyUiNoise(line) {
  const text = normalizeLc(line);
  if (!text) return true;

  const exact = new Set([
    'chatgpt',
    'new chat',
    'search',
    'projects',
    'recents',
    'gpts',
    'today',
    'yesterday',
    'send',
    'stop generating',
    'voice',
    'attach',
  ]);

  if (exact.has(text)) return true;
  if (text === 'composer') return true;
  if (text.startsWith('pick a model')) return true;
  return false;
}

function findPromptIndex(lines, prompt) {
  const target = normalizeLc(prompt);
  if (!target) return -1;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (normalizeLc(lines[i]) === target) {
      return i;
    }
  }

  const needle = target.slice(0, Math.min(target.length, 120));
  if (!needle) return -1;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (normalizeLc(lines[i]).includes(needle)) {
      return i;
    }
  }

  return -1;
}

function extractAssistantTextFromSnapshot(markdown, prompt = '', opts = {}) {
  const strictPrompt = opts.strictPrompt ?? false;
  const staticLines = parseStaticTextLines(markdown);
  if (!staticLines.length) return '';

  const promptIndex = findPromptIndex(staticLines, prompt);
  if (strictPrompt && prompt && promptIndex < 0) {
    return '';
  }

  const source = promptIndex >= 0
    ? staticLines.slice(promptIndex + 1)
    : staticLines.slice(-16);

  const cleaned = [];
  let last = '';
  for (const line of source) {
    const text = normalizeWhitespace(line);
    if (!text) continue;
    if (normalizeLc(text) === normalizeLc(prompt)) continue;
    if (isLikelyUiNoise(text)) continue;
    if (text === last) continue;
    cleaned.push(text);
    last = text;
  }

  return cleaned.join('\n\n').trim();
}

function findBy(elements, predicate) {
  for (const el of elements) {
    if (predicate(el)) return el;
  }
  return null;
}

function isTextArea(el) {
  return el.role === 'AXTextArea';
}

function isSendButton(el) {
  if (el.role !== 'AXButton') return false;
  const hay = normalizeLc([el.name, el.label, el.value, el.help, el.line].join(' '));
  if (!hay.includes('send')) return false;
  return hay.includes('messageinputprimarybuttoncontainerpart.primarybutton')
    || hay.includes('send message')
    || normalizeLc(el.name) === 'send'
    || normalizeLc(el.label) === 'send';
}

function isStopButton(el) {
  if (el.role !== 'AXButton') return false;
  const hay = normalizeLc([el.name, el.label, el.value, el.help, el.line].join(' '));
  return hay.includes('stop generating');
}

function isModelSelector(el) {
  if (el.role !== 'AXButton') return false;
  const hay = normalizeLc([el.name, el.label, el.value, el.help, el.line].join(' '));
  return hay.includes('pick a model or gpt') || hay.includes('(options)');
}

function currentModelLabel(elements) {
  const modelEl = findBy(elements, isModelSelector);
  if (!modelEl) return null;
  return normalizeWhitespace(modelEl.name || modelEl.value || modelEl.label || '') || null;
}

function elementText(el) {
  return normalizeWhitespace(el?.name || el?.value || el?.label || '');
}

function elementHasAction(el, action) {
  const target = normalizeLc(action);
  return Array.isArray(el?.actions) && el.actions.some(value => normalizeLc(value) === target);
}

function isSelectedElement(el) {
  const text = normalizeLc(el?.line || '');
  return /\bselected\b/i.test(text)
    || /\bAXSelected\s*=\s*(?:1|true)\b/i.test(text)
    || /\bselected\s*=\s*(?:1|true)\b/i.test(text)
    || text.includes(' axselected');
}

const NON_CONVERSATION_BUTTON_LABELS = new Set([
  '',
  'attach',
  'chatgpt',
  'close',
  'gpts',
  'new chat',
  'projects',
  'recents',
  'search',
  'send',
  'stop generating',
  'today',
  'voice',
  'yesterday',
]);

function isConversationButton(el) {
  if (el.role !== 'AXButton') return false;
  const text = elementText(el);
  if (!text) return false;
  if (NON_CONVERSATION_BUTTON_LABELS.has(normalizeLc(text))) return false;
  if (isSendButton(el) || isModelSelector(el) || isStopButton(el)) return false;

  const hay = normalizeLc([el.help, el.id, el.line].join(' '));
  if (hay.includes('messageinputprimarybuttoncontainerpart')) return false;
  if (hay.includes('pick a model or gpt')) return false;

  // ChatGPT sidebar conversation rows expose AXShowMenu for their context menu.
  // Other app chrome usually exposes AXPress and is filtered out above.
  return elementHasAction(el, 'AXShowMenu') || hay.includes('axshowmenu');
}

function uniqueConversationNames(elements) {
  const names = [];
  const seen = new Set();
  for (const el of elements) {
    if (!isConversationButton(el)) continue;
    const name = elementText(el);
    const key = normalizeLc(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function findConversationButton(elements, name) {
  const target = normalizeLc(name);
  if (!target) return null;

  const candidates = elements.filter(isConversationButton);
  const exact = candidates.find(el => normalizeLc(elementText(el)) === target);
  if (exact) return exact;

  return candidates.find(el => normalizeLc(elementText(el)).includes(target)) || null;
}

function elementCenter(el) {
  const frame = el?.frame;
  if (!frame) return null;
  const width = Number(frame.width);
  const height = Number(frame.height);
  if (![frame.x, frame.y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    x: frame.x + Math.min(width - 8, Math.max(12, width * 0.45)),
    y: frame.y + (height / 2),
  };
}

function inferBusy(elements) {
  const stop = findBy(elements, isStopButton);
  if (stop) return true;

  const send = findBy(elements, isSendButton);
  if (!send) return true;

  if (!send.disabled) return false;

  // Idle composer can also show a disabled send button when the text area is empty.
  const textArea = findBy(elements, isTextArea);
  const hasDraft = normalizeWhitespace(textArea?.value || '').length > 0;
  return hasDraft;
}

async function snapshotWindow(opts = {}, attempt = 0) {
  const session = await ensureSession();
  const payload = {
    pid: session.pid,
    window_id: session.windowId,
  };
  if (opts.query) payload.query = opts.query;

  try {
    const text = await callCua('get_window_state', payload, {
      imageOut: opts.imageOut,
      timeoutMs: opts.timeoutMs ?? 120_000,
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    });

    return {
      ...session,
      text,
      elements: parseIndexedElements(text),
      staticLines: parseStaticTextLines(text),
    };
  } catch (error) {
    const message = String(error?.message || error);
    if (attempt < 1 && isWindowErrorMessage(message)) {
      const nextWindowId = await refreshWindowIdForPid(session.pid).catch(() => null);
      if (nextWindowId) {
        _session = { ...session, windowId: nextWindowId };
      } else {
        _session = null;
        await launchSession();
      }
      return snapshotWindow(opts, attempt + 1);
    }
    throw error;
  }
}

function notLoggedInError() {
  return new Error('not_logged_in: open ChatGPT desktop app and sign in');
}

async function assertPromptCapableSession() {
  const snap = await snapshotWindow({ query: 'AXTextArea' });
  const hasTextArea = snap.elements.some(isTextArea);
  if (!hasTextArea) {
    throw notLoggedInError();
  }
}

async function setPromptOnSession(prompt) {
  const snap = await snapshotWindow({ query: 'AXTextArea' });
  const textArea = findBy(snap.elements, isTextArea);
  if (!textArea) {
    throw notLoggedInError();
  }

  await callCua('set_value', {
    pid: snap.pid,
    window_id: snap.windowId,
    element_index: textArea.index,
    value: String(prompt),
  }, { timeoutMs: 90_000 });
}

async function clickSendOnSession() {
  let snap = await snapshotWindow({ query: 'Send' });
  let send = findBy(snap.elements, isSendButton);

  if (!send) {
    snap = await snapshotWindow();
    send = findBy(snap.elements, isSendButton);
  }

  if (!send) {
    throw new Error('send_button_not_found');
  }
  if (send.disabled) {
    throw new Error('send_button_disabled');
  }

  await callCua('click', {
    pid: snap.pid,
    window_id: snap.windowId,
    element_index: send.index,
  });
}

async function readCurrentModelOnSession() {
  const snap = await snapshotWindow();
  return currentModelLabel(snap.elements);
}

function modelCandidates(name) {
  const raw = normalizeLc(name);
  const candidates = [];

  const push = (value) => {
    const text = normalizeWhitespace(value);
    if (!text) return;
    if (candidates.includes(text)) return;
    candidates.push(text);
  };

  push(name);

  if (raw === 'pro' || raw.includes('pro')) {
    push('5.5 Pro');
    push('GPT-5.5 Pro');
    push('GPT-5 Pro');
    push('Pro');
  }

  if (raw === 'thinking' || raw === 'gpt-5' || raw === 'gpt5') {
    push('GPT-5');
    push('Thinking');
  }

  return candidates;
}

async function openModelSelectorOnSession() {
  let snap = await snapshotWindow({ query: 'Pick a model or GPT' });
  let modelButton = findBy(snap.elements, isModelSelector);
  if (!modelButton) {
    snap = await snapshotWindow();
    modelButton = findBy(snap.elements, isModelSelector);
  }

  if (!modelButton) {
    throw new Error('model_selector_not_found');
  }

  await callCua('click', {
    pid: snap.pid,
    window_id: snap.windowId,
    element_index: modelButton.index,
  });
}

async function selectModelOnSession(name) {
  if (!normalizeWhitespace(name)) {
    throw new Error('model name required');
  }

  await openModelSelectorOnSession();
  await delay(220);

  const candidates = modelCandidates(name);
  for (const candidate of candidates) {
    const snap = await snapshotWindow({ query: candidate });
    const target = findBy(snap.elements, (el) => {
      if (!['AXButton', 'AXMenuItem'].includes(el.role)) return false;
      if (isModelSelector(el)) return false;
      const hay = normalizeLc([el.name, el.value, el.label, el.help, el.line].join(' '));
      return hay.includes(normalizeLc(candidate));
    });

    if (!target) continue;

    await callCua('click', {
      pid: snap.pid,
      window_id: snap.windowId,
      element_index: target.index,
    });

    await delay(300);
    return { model: (await readCurrentModelOnSession()) || candidate };
  }

  await callCua('press_key', { pid: _session.pid, key: 'escape' }).catch(() => {});
  throw new Error(`model "${name}" not found`);
}

async function newChatOnSession() {
  const session = await ensureSession();
  await callCua('hotkey', { pid: session.pid, keys: ['cmd', 'n'] });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snap = await snapshotWindow({ query: 'AXTextArea' });
    if (snap.elements.some(isTextArea)) return;
    await delay(300);
  }
  throw new Error('new_chat_verify_failed');
}

async function listConversationsOnSession() {
  const snap = await snapshotWindow();
  return uniqueConversationNames(snap.elements);
}

async function clickConversationButton(snap, button) {
  const center = elementCenter(button);
  if (center) {
    await callCua('click', {
      pid: snap.pid,
      window_id: snap.windowId,
      x: center.x,
      y: center.y,
    });
    return { method: 'pixel', x: center.x, y: center.y };
  }

  // Fallback for CUA builds that omit element frames in the text rendering:
  // focus the AX row and activate it through the app's keyboard handling.
  await callCua('press_key', {
    pid: snap.pid,
    window_id: snap.windowId,
    element_index: button.index,
    key: 'return',
  });
  return { method: 'keyboard', element_index: button.index };
}

async function navigateToConversationOnSession(name) {
  const targetName = normalizeWhitespace(name);
  if (!targetName) throw new Error('conversation name required');

  let snap = await snapshotWindow({ query: targetName });
  let button = findConversationButton(snap.elements, targetName);
  if (!button) {
    snap = await snapshotWindow();
    button = findConversationButton(snap.elements, targetName);
  }
  if (!button) {
    throw new Error(`conversation_not_found:${targetName}`);
  }

  const detail = await clickConversationButton(snap, button);
  await delay(700);

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const verify = await snapshotWindow({ query: targetName });
    const selected = findConversationButton(verify.elements, targetName);
    if (selected && isSelectedElement(selected)) {
      return { key: elementText(selected), selected: true, ...detail };
    }
    if (verify.elements.some(isTextArea) && findConversationButton(verify.elements, targetName)) {
      return { key: targetName, selected: false, ...detail };
    }
    await delay(250);
  }

  throw new Error(`conversation_navigation_verify_failed:${targetName}`);
}

async function openConversationContextMenu(snap, button) {
  const center = elementCenter(button);
  if (center) {
    await callCua('right_click', {
      pid: snap.pid,
      window_id: snap.windowId,
      x: center.x,
      y: center.y,
    });
    return { method: 'pixel', x: center.x, y: center.y };
  }

  await callCua('right_click', {
    pid: snap.pid,
    window_id: snap.windowId,
    element_index: button.index,
  });
  return { method: 'ax_show_menu', element_index: button.index };
}

async function chooseRenameFromOpenMenu(pid) {
  await delay(180);
  await callCua('press_key', { pid, key: 'r' });
  await delay(120);
  await callCua('press_key', { pid, key: 'return' });
  await delay(220);
}

async function replaceFocusedText(pid, text) {
  await callCua('hotkey', { pid, keys: ['cmd', 'a'] }).catch(() => {});
  await delay(80);

  try {
    await callCua('type_text', { pid, text }, { timeoutMs: 30_000 });
  } catch {
    await callCua('type_text_chars', { pid, text, delay_ms: 10 }, { timeoutMs: 30_000 });
  }

  await delay(120);
  await callCua('press_key', { pid, key: 'return' });
}

async function renameConversationOnSession(oldName, newName) {
  const from = normalizeWhitespace(oldName);
  const to = normalizeWhitespace(newName);
  if (!from) throw new Error('old conversation name required');
  if (!to) throw new Error('new conversation name required');

  let snap = await snapshotWindow({ query: from });
  let button = findConversationButton(snap.elements, from);
  if (!button) {
    snap = await snapshotWindow();
    button = findConversationButton(snap.elements, from);
  }
  if (!button) {
    throw new Error(`conversation_not_found:${from}`);
  }

  const menuDetail = await openConversationContextMenu(snap, button);
  await chooseRenameFromOpenMenu(snap.pid);
  await replaceFocusedText(snap.pid, to);
  await delay(700);

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const names = await listConversationsOnSession();
    if (names.some(name => normalizeLc(name) === normalizeLc(to))) {
      return { oldName: from, newName: to, renamed: true, ...menuDetail };
    }
    await delay(300);
  }

  throw new Error(`conversation_rename_verify_failed:${from}->${to}`);
}

async function waitForCompletion(prompt, opts = {}) {
  const mode = opts.mode || 'text';
  const timeoutMs = mode === 'image'
    ? Number(opts.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS)
    : Number(opts.timeoutMs ?? TEXT_RESPONSE_TIMEOUT_MS);

  const baselineSignature = String(opts.baselineSignature || '');
  const started = Date.now();
  const deadline = started + timeoutMs;
  let seenBusy = false;
  let lastSnap = null;

  while (Date.now() < deadline) {
    const snap = await snapshotWindow();
    lastSnap = snap;

    const busy = inferBusy(snap.elements);
    if (busy) seenBusy = true;

    const responseText = extractAssistantTextFromSnapshot(snap.text, prompt, { strictPrompt: true });
    const changed = staticSignature(snap.staticLines) !== baselineSignature;

    if (!busy) {
      if (mode === 'image') {
        if (seenBusy || changed) {
          return { snap, text: responseText };
        }
      } else {
        if (responseText) {
          return { snap, text: responseText };
        }
        if (seenBusy && changed) {
          return { snap, text: extractAssistantTextFromSnapshot(snap.text, prompt) };
        }
      }
    }

    await delay(POLL_INTERVAL_MS);
  }

  const timeoutSec = Math.round(timeoutMs / 1000);
  throw new Error(`response_timeout:${timeoutSec}s${lastSnap ? ` mode=${mode}` : ''}`);
}

async function captureWindowScreenshot(outputPath) {
  const session = await ensureSession();
  await callCua('screenshot', {
    window_id: session.windowId,
    format: 'png',
  }, {
    imageOut: outputPath,
    timeoutMs: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function queryOnSession(prompt, opts = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('prompt required');
  }

  await assertPromptCapableSession();

  if (opts.fresh) {
    await newChatOnSession();
  }
  if (opts.model) {
    await selectModelOnSession(opts.model);
  }
  if (opts.thinking) {
    await setThinkingOnSession(opts.thinking);
  }

  const baseline = await snapshotWindow();
  await setPromptOnSession(prompt);
  await clickSendOnSession();

  const completion = await waitForCompletion(prompt, {
    mode: opts.mode || 'text',
    timeoutMs: opts.timeoutMs,
    baselineSignature: staticSignature(baseline.staticLines),
  });

  const text = completion.text || extractAssistantTextFromSnapshot(completion.snap.text, prompt);

  if ((opts.mode || 'text') === 'image') {
    const outputDir = resolveOutputDir(prompt, opts.output_dir || opts.outputDir);
    const filePath = join(outputDir, '01.png');
    await captureWindowScreenshot(filePath);
    return { text, files: [filePath], key: 'default' };
  }

  return { text, files: [], key: 'default' };
}

async function setThinkingOnSession(level) {
  if (!normalizeWhitespace(level)) {
    throw new Error('thinking level required');
  }
  // Desktop app thinking controls are model-dependent; keep API-compatible no-op.
  return { level: normalizeWhitespace(level), changed: false, detail: 'cua_thinking_control_not_available' };
}

export async function getPage() {
  const session = await ensureSession();
  return { ...session };
}

export async function createEphemeralChatPage(requestId) {
  const session = await ensureSession();
  const page = {
    requestId: String(requestId || ''),
    pid: session.pid,
    windowId: session.windowId,
    createdAt: nowIso(),
  };
  _ephemeral.set(page, { marker: `cua-active:${page.requestId}` });
  return page;
}

export async function markEphemeralTabError(page, requestId) {
  if (!page) return;
  _ephemeral.set(page, { marker: `cua-error:${String(requestId || page.requestId || '')}` });
}

export async function closeEphemeralPage(page) {
  if (!page) return;
  _ephemeral.delete(page);
}

export async function closeOwnedEphemeralPages(opts = {}) {
  const includeErrors = opts.includeErrors ?? false;
  let closed = 0;
  for (const [page, meta] of _ephemeral.entries()) {
    const isError = String(meta?.marker || '').startsWith('cua-error:');
    if (isError && !includeErrors) continue;
    _ephemeral.delete(page);
    closed += 1;
  }
  return { closed };
}

export async function cleanupEphemeralTabs(opts = {}) {
  return closeOwnedEphemeralPages({ includeErrors: Boolean(opts.includeErrors) });
}

async function _statusImpl() {
  try {
    await ensureSession();
    const snap = await snapshotWindow();

    const hasInput = snap.elements.some(isTextArea);
    if (!hasInput) {
      return { state: 'not_logged_in', model: null, thinking: null };
    }

    const busy = inferBusy(snap.elements);
    const model = currentModelLabel(snap.elements);
    return {
      state: busy ? 'busy' : 'ready',
      model,
      thinking: null,
      pill: model,
      backend: 'cua',
    };
  } catch (error) {
    log('status error', error?.message || error);
    return { state: 'not_logged_in', model: null, thinking: null, backend: 'cua' };
  }
}
export const status = () => serialize(_statusImpl);

export async function queryInPage(_page, prompt, opts = {}) {
  return serialize(() => queryOnSession(prompt, { ...opts, mode: opts.mode || 'text' }));
}

async function _queryImpl(prompt, opts = {}) {
  return queryOnSession(prompt, { ...opts, mode: 'text' });
}
export const query = (prompt, opts) => serialize(() => _queryImpl(prompt, opts));

async function _generateImageImpl(prompt, opts = {}) {
  return queryOnSession(prompt, { ...opts, mode: 'image' });
}
export const generateImage = (prompt, opts) => serialize(() => _generateImageImpl(prompt, opts));

async function _readLastImpl() {
  const snap = await snapshotWindow();
  const text = extractAssistantTextFromSnapshot(snap.text, '');
  return { text, key: 'default' };
}
export const readLast = () => serialize(_readLastImpl);

async function _newChatImpl() {
  await newChatOnSession();
  return { key: 'default' };
}
export const newChat = () => serialize(_newChatImpl);

async function _listConversationsImpl() {
  return listConversationsOnSession();
}
export const listConversations = () => serialize(_listConversationsImpl);

async function _navigateToConversationImpl(name) {
  return navigateToConversationOnSession(name);
}
export const navigateToConversation = (name) => serialize(() => _navigateToConversationImpl(name));

async function _renameConversationImpl(oldName, newName) {
  return renameConversationOnSession(oldName, newName);
}
export const renameConversation = (oldName, newName) => serialize(() => _renameConversationImpl(oldName, newName));

async function _getModelImpl() {
  const model = await readCurrentModelOnSession();
  if (model) return model;
  const info = parsePillText(null);
  return info.model;
}
export const getModel = () => serialize(_getModelImpl);

async function _setModelImpl(name) {
  return selectModelOnSession(name);
}
export const setModel = (name) => serialize(() => _setModelImpl(name));

async function _getThinkingImpl() {
  return null;
}
export const getThinking = () => serialize(_getThinkingImpl);

async function _setThinkingImpl(level) {
  return setThinkingOnSession(level);
}
export const setThinking = (level) => serialize(() => _setThinkingImpl(level));

async function _stopImpl() {
  const snap = await snapshotWindow({ query: 'Stop generating' });
  const stop = findBy(snap.elements, isStopButton);
  if (!stop) return { stopped: false, detail: 'not_generating' };

  await callCua('click', {
    pid: snap.pid,
    window_id: snap.windowId,
    element_index: stop.index,
  });
  return { stopped: true };
}
export const stop = () => serialize(_stopImpl);

export async function checkSelectors() {
  return serialize(async () => {
    const snap = await snapshotWindow();
    const textArea = findBy(snap.elements, isTextArea);
    const send = findBy(snap.elements, isSendButton);
    const model = findBy(snap.elements, isModelSelector);

    return [
      { path: 'cua.driver', selector: CUA_BIN, count: existsSync(CUA_BIN) ? 1 : 0 },
      { path: 'cua.prompt_input', selector: 'AXTextArea', count: textArea ? 1 : 0 },
      { path: 'cua.send_button', selector: 'Send', count: send ? 1 : 0 },
      { path: 'cua.model_selector', selector: 'Pick a model or GPT', count: model ? 1 : 0 },
    ];
  });
}

export async function shutdown() {
  _ephemeral.clear();
  _session = null;
}

// Launch hidden ChatGPT app immediately so first request has warm state.
ensureSession().catch((error) => {
  log('initial launch deferred:', error?.message || error);
});
