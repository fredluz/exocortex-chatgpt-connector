// browser-controller.mjs
// Owns the patchright browser session.
// Legacy sync usage: one singleton page + serialized mutating operations.
// Async mailbox usage: ephemeral request tabs created in the shared context.

import { chromium } from 'patchright';
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePillText } from './parse-pill.mjs';
import { getCDPFilePath, getImagesDir, getProfileDir } from './runtime-paths.mjs';
export { parsePillText };

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = getProfileDir();
const CDP_FILE = getCDPFilePath();
const IMAGE_ROOT_DIR = getImagesDir();
const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const SELECTORS = JSON.parse(readFileSync(join(__dirname, 'selectors.json'), 'utf8'));
const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const TAB_MARK_ACTIVE = 'exocortex-chatgpt-active:';
const TAB_MARK_ERROR = 'exocortex-chatgpt-error:';

let _browser = null;
let _context = null;
let _page = null;
let _ownsBrowser = false;
const _ownedEphemeralTabs = new Map();

function isContextClosedError(error) {
  return /target page, context or browser has been closed/i.test(String(error?.message || error || ''));
}

function resetSessionHandles() {
  _browser = null;
  _context = null;
  _page = null;
  _ownsBrowser = false;
  _ownedEphemeralTabs.clear();
}

function isContextUsable() {
  if (!_context) return false;
  if (_browser && typeof _browser.isConnected === 'function' && !_browser.isConnected()) return false;
  try {
    _context.pages();
    return true;
  } catch {
    return false;
  }
}

async function disconnectAttachedBrowser(browser) {
  if (!browser) return;
  if (typeof browser.disconnect === 'function') {
    await browser.disconnect();
  }
}

// FIFO mutex for legacy singleton-page mutations.
let _chain = Promise.resolve();
function serialize(fn) {
  const next = _chain.then(fn, fn);
  _chain = next.catch(() => {});
  return next;
}

// Narrow mutex only around context.newPage().
let _newPageChain = Promise.resolve();
function serializePageCreate(fn) {
  const next = _newPageChain.then(fn, fn);
  _newPageChain = next.catch(() => {});
  return next;
}

function log(...a) { console.error('[controller]', ...a); }

function normalizeAttachmentList(value) {
  return Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : [];
}

function validateAttachmentPath(filePath, kind) {
  if (!isAbsolute(filePath)) {
    throw new Error(`attachment_path_not_absolute:${filePath}`);
  }

  let info;
  try {
    info = statSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`attachment_not_found:${filePath}`);
    throw error;
  }

  if (!info.isFile()) {
    throw new Error(`attachment_not_file:${filePath}`);
  }

  if (kind === 'image' && !IMAGE_ATTACHMENT_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error(`unsupported_image_attachment:${filePath}`);
  }

  return filePath;
}

function collectAttachmentPaths(opts = {}) {
  const images = normalizeAttachmentList(opts.images).map(path => validateAttachmentPath(path, 'image'));
  const files = normalizeAttachmentList(opts.files).map(path => validateAttachmentPath(path, 'file'));
  return [...new Set([...images, ...files])];
}

async function findAttachmentFileInput(page) {
  const attachmentSelectors = SELECTORS.attachments || {};
  const fileInputSelectors = [
    attachmentSelectors.composer_file_input,
    attachmentSelectors.file_input,
    'input[type="file"]',
  ].filter(Boolean);

  for (const selector of fileInputSelectors) {
    const input = page.locator(selector).first();
    if (await input.count()) return input;
  }

  const attachButtonSelector = attachmentSelectors.attach_button;
  if (attachButtonSelector) {
    const attachButton = page.locator(attachButtonSelector).first();
    if (await attachButton.count()) {
      try {
        await attachButton.click({ timeout: 5_000 });
      } catch {
        await attachButton.evaluate((el) => el.click());
      }
    }
  }

  for (const selector of fileInputSelectors) {
    const input = page.locator(selector).first();
    try {
      await input.waitFor({ state: 'attached', timeout: 5_000 });
      return input;
    } catch {}
  }

  throw new Error('attachment_file_input_not_found');
}

async function waitForAttachmentUploads(page) {
  const uploadProgressSelector = SELECTORS.attachments?.upload_progress;
  if (!uploadProgressSelector) {
    await page.waitForTimeout(500);
    return;
  }

  await page.waitForTimeout(500);
  await page.waitForFunction((selector) => {
    const nodes = Array.from(document.querySelectorAll(selector));
    if (!nodes.length) return true;

    return nodes.every((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
      if (!visible) return true;

      const text = [
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('aria-valuetext'),
      ].filter(Boolean).join(' ').toLowerCase();

      return el.getAttribute('role') !== 'progressbar'
        && !/(upload|hochlad|processing|verarbeit|progress|%)/i.test(text);
    });
  }, uploadProgressSelector, { timeout: 120_000 });
}

async function uploadAttachments(page, opts = {}) {
  const filePaths = collectAttachmentPaths(opts);
  if (!filePaths.length) return;

  const fileInput = await findAttachmentFileInput(page);
  await fileInput.setInputFiles(filePaths);
  await waitForAttachmentUploads(page);
}

function isChatGPTUrl(url) {
  return typeof url === 'string' && url.startsWith('https://chatgpt.com');
}

function isAttachOnlyMode() {
  return process.env.CHATGPT_MCP_ATTACH_ONLY === '1';
}

function chromeLaunchArgs(cdpPort) {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
  ];
  if (process.env.CHATGPT_VISIBLE === '1') {
    args.unshift('--start-maximized');
  } else {
    args.push('--window-position=-2000,-2000', '--window-size=1200,900');
  }
  return args;
}

async function tryConnectCDP() {
  const url = process.env.CHATGPTPRO_CDP
    || (existsSync(CDP_FILE) ? readFileSync(CDP_FILE, 'utf8').trim() : null);
  if (!url) return null;

  try {
    const browser = await chromium.connectOverCDP(url);
    const context = browser.contexts()[0];
    if (!context) {
      await disconnectAttachedBrowser(browser).catch(() => {});
      return null;
    }
    log('attached via CDP', url);
    return { browser, context, owns: false };
  } catch (error) {
    log('CDP connect failed:', error.message);
    return null;
  }
}

async function launchOwn() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const cdpUrl = process.env.CHATGPTPRO_CDP || 'http://127.0.0.1:9222';
  let cdpPort = 9222;
  try {
    const parsed = new URL(cdpUrl);
    cdpPort = Number(parsed.port || 9222);
  } catch {}

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: chromeLaunchArgs(cdpPort),
  });
  writeFileSync(CDP_FILE, `http://127.0.0.1:${cdpPort}\n`);
  log('launched own persistent context');
  return { browser: null, context, owns: true };
}

async function getContext(opts = {}) {
  const launchIfNeeded = opts.launchIfNeeded ?? true;
  if (isContextUsable()) return _context;
  resetSessionHandles();

  const attached = await tryConnectCDP();
  if (!attached && isAttachOnlyMode()) {
    throw new Error('no_shared_browser_owner: launch the browser owner first (`exocortex-chatgpt launch`)');
  }
  if (!attached && !launchIfNeeded) return null;

  const resolved = attached || (await launchOwn());
  _browser = resolved.browser;
  _context = resolved.context;
  _ownsBrowser = resolved.owns;
  return _context;
}

async function pickChatGPTPage(context) {
  for (const p of context.pages()) {
    try {
      if (isChatGPTUrl(p.url())) return p;
    } catch {}
  }

  const p = context.pages().find((page) => {
    try {
      return page.url() === 'about:blank';
    } catch {
      return false;
    }
  }) ?? await context.newPage();
  await p.goto(SELECTORS.urls.home, { waitUntil: 'domcontentloaded' });
  return p;
}

export async function getPage() {
  if (_page && !_page.isClosed() && isContextUsable()) return _page;
  const context = await getContext();
  _page = await pickChatGPTPage(context);
  return _page;
}

async function setTabMarker(page, marker) {
  await page.evaluate((value) => { window.name = value; }, marker).catch(() => {});
}

async function getTabMarker(page) {
  try {
    return await page.evaluate(() => String(window.name || ''));
  } catch {
    return '';
  }
}

export async function createEphemeralChatPage(requestId) {
  let lastError = null;
  let page = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const context = await getContext();
      page = await serializePageCreate(async () => {
        const p = await context.newPage();
        await p.goto(SELECTORS.urls.home, { waitUntil: 'domcontentloaded' });
        return p;
      });
      break;
    } catch (error) {
      lastError = error;
      if (!isContextClosedError(error) || attempt === 1) throw error;
      resetSessionHandles();
    }
  }
  if (!page && lastError) throw lastError;

  _ownedEphemeralTabs.set(page, {
    requestId: String(requestId || ''),
    marker: `${TAB_MARK_ACTIVE}${requestId || ''}`,
  });
  await setTabMarker(page, `${TAB_MARK_ACTIVE}${requestId || ''}`);
  return page;
}

export async function markEphemeralTabError(page, requestId) {
  if (!page || page.isClosed()) return;

  const rid = String(requestId || _ownedEphemeralTabs.get(page)?.requestId || '');
  _ownedEphemeralTabs.set(page, { requestId: rid, marker: `${TAB_MARK_ERROR}${rid}` });
  await setTabMarker(page, `${TAB_MARK_ERROR}${rid}`);
}

export async function closeEphemeralPage(page) {
  if (!page) return;
  _ownedEphemeralTabs.delete(page);
  try {
    if (!page.isClosed()) await page.close();
  } catch {}
}

export async function closeOwnedEphemeralPages(opts = {}) {
  const includeErrors = opts.includeErrors ?? false;
  const pages = [..._ownedEphemeralTabs.entries()]
    .filter(([, meta]) => includeErrors || !String(meta?.marker || '').startsWith(TAB_MARK_ERROR))
    .map(([page]) => page);

  for (const page of pages) {
    await closeEphemeralPage(page);
  }
}

export async function cleanupEphemeralTabs(opts = {}) {
  const includeErrors = opts.includeErrors ?? false;
  const includeUnmarked = opts.includeUnmarked ?? false;

  let closed = 0;
  const context = await getContext({ launchIfNeeded: opts.launchIfNeeded ?? true });
  if (!context) return { closed };

  for (const page of context.pages()) {
    try {
      if (page === _page) continue;
      if (page.isClosed()) continue;
      if (!isChatGPTUrl(page.url())) continue;

      const marker = await getTabMarker(page);
      const isActive = marker.startsWith(TAB_MARK_ACTIVE);
      const isError = marker.startsWith(TAB_MARK_ERROR);
      const isMarked = isActive || isError;

      const shouldClose = isActive
        || (isError && includeErrors)
        || (!isMarked && includeUnmarked);

      if (!shouldClose) continue;

      _ownedEphemeralTabs.delete(page);
      await page.close();
      closed += 1;
    } catch {}
  }

  return { closed };
}

async function readPillInfo(page) {
  const pill = page.locator(SELECTORS.thinking.pill_trigger);
  if (!(await pill.count())) return parsePillText(null);
  const raw = (await pill.first().innerText()).trim();
  return parsePillText(raw);
}

async function detectPromptCapability(page) {
  const url = page.url();
  if (SELECTORS.urls.login_probe_paths.some(p => url.includes(p))) {
    return { state: 'not_logged_in', url, reason: 'login_url' };
  }

  const loginMarker = await page.locator(SELECTORS.signals.login_required_marker).count().catch(() => 0);
  if (loginMarker > 0) {
    return { state: 'not_logged_in', url, reason: 'login_marker' };
  }

  const hasInput = await page.locator(SELECTORS.composer.prompt_input).count().catch(() => 0);
  if (hasInput > 0) {
    return { state: 'ready', url, reason: 'prompt_input' };
  }

  const roleInput = SELECTORS.composer.prompt_input_role;
  if (roleInput) {
    const hasRoleInput = await page.locator(roleInput).count().catch(() => 0);
    if (hasRoleInput > 0) {
      return { state: 'ready', url, reason: 'prompt_input_role' };
    }
  }

  return { state: 'loading', url, reason: 'no_prompt_or_login_marker' };
}

async function waitForPromptCapability(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() <= deadline) {
    last = await detectPromptCapability(page);
    if (last.state !== 'loading') return last;
    await page.waitForTimeout(pollMs).catch(() => {});
  }

  return last ?? { state: 'loading', url: page.url(), reason: 'timeout' };
}

function pageNotReadyError(result) {
  return new Error(`chatgpt_page_not_ready: prompt composer did not appear (${result?.reason || 'unknown'} at ${result?.url || 'unknown_url'})`);
}

export async function status() {
  try {
    const page = await getPage();
    const promptState = await waitForPromptCapability(page, { timeoutMs: 15_000 });
    if (promptState.state === 'not_logged_in') {
      return { state: 'not_logged_in', model: null, thinking: null };
    }
    if (promptState.state !== 'ready') {
      return { state: 'loading', model: null, thinking: null, reason: promptState.reason };
    }

    const generating = await page.locator(SELECTORS.signals.generating).count();
    const state = generating ? 'busy' : 'ready';
    const info = await readPillInfo(page);
    return { state, model: info.model, thinking: info.thinking, pill: info.pill };
  } catch (error) {
    log('status error', error.message);
    return { state: 'error', model: null, thinking: null, error: error.message || String(error) };
  }
}

async function ensureReady(page) {
  await page.waitForSelector(SELECTORS.composer.prompt_input, { timeout: 15_000 });
  await page.waitForSelector(SELECTORS.signals.generating, { state: 'detached', timeout: 90_000 }).catch(() => {});
}

async function waitForResponse(page, prevAssistantCount, opts = {}) {
  const assistantTimeoutMs = opts.assistantTimeoutMs ?? 60_000;
  const generatingTimeoutMs = opts.generatingTimeoutMs ?? 0;

  await page.waitForFunction(
    ({ sel, prev }) => document.querySelectorAll(sel).length > prev,
    { sel: SELECTORS.conversation.message_assistant, prev: prevAssistantCount },
    { timeout: assistantTimeoutMs },
  );

  await page.waitForSelector(SELECTORS.signals.generating, { state: 'detached', timeout: generatingTimeoutMs });
  await page.waitForSelector(SELECTORS.signals.turn_finished_marker, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(250);
}

function isConversationUrl(rawUrl) {
  try {
    return /^\/c\/[^/?#]+/.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

async function waitForConversationUrl(page, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const previousUrl = opts.previousUrl ? String(opts.previousUrl) : '';

  if (isConversationUrl(page.url()) && (!previousUrl || page.url() !== previousUrl)) {
    return true;
  }

  try {
    await page.waitForFunction(
      ({ previous }) => /^\/c\/[^/?#]+/.test(window.location.pathname)
        && (!previous || window.location.href !== previous),
      { previous: previousUrl },
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    if (isConversationUrl(page.url()) && !previousUrl) return true;
    return false;
  }
}

function composerSubmitSelectors() {
  return [
    SELECTORS.composer.send_button,
    SELECTORS.composer.submit_button_any,
    '#composer-submit-button',
    'button[data-testid="send-button"]',
  ].filter(Boolean);
}

async function findReadyComposerSubmitButton(page) {
  const selectors = composerSubmitSelectors();
  const handle = await page.waitForFunction((candidateSelectors) => {
    const seen = new Set();
    const nodes = [];

    for (const selector of candidateSelectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        seen.add(node);
        nodes.push(node);
      }
    }

    return nodes.find((button) => {
      if (!(button instanceof HTMLButtonElement)) return false;
      const style = window.getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      const visible = style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
      if (!visible) return false;
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;

      const testId = button.getAttribute('data-testid') || '';
      const ariaLabel = button.getAttribute('aria-label') || '';
      const title = button.getAttribute('title') || '';
      const text = button.textContent || '';
      const stateText = `${testId} ${ariaLabel} ${title} ${text}`.toLowerCase();

      return testId !== 'stop-button'
        && !/(stop|streaming beenden|arrêter|detener|interromper)/i.test(stateText);
    }) || null;
  }, selectors, { timeout: 10_000 });

  return handle.asElement();
}

async function clearComposerInput(page, input) {
  await input.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');

  const cleared = await page.waitForFunction((selector) => {
    const el = document.querySelector(selector);
    if (!el) return true;
    const value = 'value' in el ? el.value : el.textContent;
    return !String(value || '').trim();
  }, SELECTORS.composer.prompt_input, { timeout: 1_000 }).then(() => true, () => false);

  if (cleared) return;

  await input.evaluate((el) => {
    if ('value' in el) {
      el.value = '';
    } else {
      el.textContent = '';
    }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'deleteContentBackward',
    }));
  });
}

async function ensureSidebarVisible(page) {
  const sidebar = SELECTORS.sidebar || {};
  const linksSelector = sidebar.conversation_links;
  if (!linksSelector) return false;

  const links = page.locator(linksSelector);
  if ((await links.count().catch(() => 0)) && (await links.first().isVisible().catch(() => false))) {
    return true;
  }

  const toggleSelector = sidebar.toggle_button;
  if (toggleSelector) {
    const toggle = page.locator(toggleSelector).first();
    if (await toggle.count().catch(() => 0)) {
      try {
        await toggle.click({ timeout: 5_000 });
      } catch {
        await toggle.evaluate((el) => el.click()).catch(() => {});
      }
    }
  }

  await page.waitForSelector(linksSelector, { state: 'attached', timeout: 5_000 }).catch(() => {});
  return Boolean(await links.count().catch(() => 0));
}

async function clickFirstVisible(locator, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);
      if (!(await item.isVisible().catch(() => false))) continue;
      let clicked = false;
      try {
        await item.click({ timeout: 1_000 });
        clicked = true;
      } catch {
        try {
          await item.evaluate((el) => el.click());
          clicked = true;
        } catch {}
      }
      if (clicked) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function markCurrentConversationSidebarItem(page) {
  const sidebar = SELECTORS.sidebar || {};
  const linkSelector = sidebar.conversation_links;
  if (!linkSelector) return false;

  return page.evaluate(({ linkSelector, currentSelector }) => {
    for (const node of document.querySelectorAll('[data-exocortex-current-conversation]')) {
      node.removeAttribute('data-exocortex-current-conversation');
    }

    const candidates = [];
    if (currentSelector) candidates.push(...document.querySelectorAll(currentSelector));
    candidates.push(...document.querySelectorAll(linkSelector));

    const linkFor = (node) => {
      if (!node) return null;
      if (node.matches?.('a[href]')) return node;
      return node.querySelector?.('a[href]') || node.closest?.('a[href]') || null;
    };

    const currentPath = window.location.pathname;
    for (const candidate of candidates) {
      const link = linkFor(candidate);
      if (!link) continue;
      let path = '';
      try {
        path = new URL(link.getAttribute('href') || link.href || '', window.location.href).pathname;
      } catch {}
      if (path !== currentPath) continue;
      const item = link.closest('[data-testid*="conversation"], li, [role="listitem"]') || link;
      item.setAttribute('data-exocortex-current-conversation', 'true');
      return true;
    }

    const first = document.querySelector(linkSelector);
    if (!first) return false;
    const item = first.closest?.('[data-testid*="conversation"], li, [role="listitem"]') || first;
    item.setAttribute('data-exocortex-current-conversation', 'true');
    return true;
  }, {
    linkSelector,
    currentSelector: sidebar.conversation_link_current || '',
  });
}

async function clickRenameMenuItem(page) {
  const sidebar = SELECTORS.sidebar || {};
  const menuSelector = sidebar.rename_menu_items;
  const texts = Array.isArray(sidebar.rename_text) ? sidebar.rename_text : ['Rename'];
  if (!menuSelector) return false;

  for (const text of texts) {
    if (await clickFirstVisible(page.locator(menuSelector, { hasText: text }), 1_500)) {
      return true;
    }
  }

  return false;
}

async function openConversationActionMenu(page, item) {
  try {
    await item.scrollIntoViewIfNeeded({ timeout: 2_000 });
  } catch {}

  try {
    await item.hover({ timeout: 3_000 });
  } catch {}

  try {
    await item.click({ button: 'right', timeout: 2_000 });
    if (await clickRenameMenuItem(page)) return true;
  } catch {}

  await page.keyboard.press('Escape').catch(() => {});

  try {
    await item.hover({ timeout: 3_000 });
  } catch {}

  const menuButtonSelector = SELECTORS.sidebar?.conversation_menu_button;
  if (!menuButtonSelector) return false;

  const scoped = item.locator(menuButtonSelector);
  if (await clickFirstVisible(scoped, 2_000)) return true;

  const sidebar = page.locator(SELECTORS.sidebar?.container || 'nav');
  return clickFirstVisible(sidebar.locator(menuButtonSelector), 2_000);
}

async function focusRenameInput(page) {
  const renameInputSelector = SELECTORS.sidebar?.rename_input;
  if (!renameInputSelector) return false;

  return page.evaluate((selector) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const usable = (el) => el.id !== 'prompt-textarea'
      && !el.closest('form:has(#prompt-textarea)')
      && visible(el);

    const active = document.activeElement;
    if (active && active.matches?.(selector) && usable(active)) return true;

    const input = Array.from(document.querySelectorAll(selector)).find(usable);
    if (!input) return false;
    input.focus();
    return document.activeElement === input;
  }, renameInputSelector).catch(() => false);
}

async function typeFocusedRename(page, newName) {
  if (!(await focusRenameInput(page))) return false;

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.insertText(String(newName));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  return true;
}

export async function renameConversation(page, newName, opts = {}) {
  const title = String(newName || '').trim();
  if (!title) return false;

  if (!(await waitForConversationUrl(page, { previousUrl: opts.previousUrl, timeoutMs: opts.timeoutMs }))) {
    return false;
  }

  if (!(await ensureSidebarVisible(page))) return false;
  if (!(await markCurrentConversationSidebarItem(page))) return false;

  const item = page.locator('[data-exocortex-current-conversation="true"]').first();
  if (!(await item.count().catch(() => 0))) return false;

  if (await openConversationActionMenu(page, item)) {
    if (await typeFocusedRename(page, title)) return true;
  }

  if (!(await clickRenameMenuItem(page))) return false;
  return typeFocusedRename(page, title);
}

export async function navigateToConversation(page, name, opts = {}) {
  const targetName = String(name || '').trim();
  if (!targetName) return false;
  if (!(await ensureSidebarVisible(page))) return false;

  const clickedHref = await page.evaluate(({ selector, name }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const wanted = normalize(name);
    const linkFor = (node) => {
      if (!node) return null;
      if (node.matches?.('a[href]')) return node;
      return node.querySelector?.('a[href]') || node.closest?.('a[href]') || null;
    };

    const candidates = Array.from(document.querySelectorAll(selector))
      .map((node) => ({ node, link: linkFor(node), text: normalize(node.textContent) }))
      .filter((item) => item.link && item.text);

    const match = candidates.find((item) => item.text === wanted)
      || candidates.find((item) => item.text.includes(wanted));
    if (!match) return '';

    match.link.scrollIntoView({ block: 'center', inline: 'nearest' });
    match.link.click();
    return match.link.href || match.link.getAttribute('href') || '';
  }, {
    selector: SELECTORS.sidebar?.conversation_links || 'nav a[href^="/c/"]',
    name: targetName,
  }).catch(() => '');

  if (!clickedHref) return false;

  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    const target = new URL(clickedHref, page.url());
    await page.waitForURL((url) => url.pathname === target.pathname, { timeout: timeoutMs });
  } catch {
    await page.waitForTimeout(500);
  }
  await page.waitForSelector(SELECTORS.composer.prompt_input, { timeout: 10_000 }).catch(() => {});
  return true;
}

async function bestEffortRenameConversation(page, requestId, opts = {}) {
  if (!requestId) return false;
  try {
    const renamed = await renameConversation(page, requestId, opts);
    if (!renamed) log('conversation rename skipped', requestId);
    return renamed;
  } catch (error) {
    log('conversation rename failed', requestId, error?.message || error);
    return false;
  }
}

async function readLastAssistantPayload(page) {
  return page.evaluate((sel) => {
    const nodes = document.querySelectorAll(sel);
    if (!nodes.length) return { text: '', images: [] };
    const el = nodes[nodes.length - 1];
    const text = (el.innerText || el.textContent || '').trim();
    const images = Array.from(el.querySelectorAll('img, source[srcset]'))
      .map((node) => {
        if (node.tagName.toLowerCase() === 'source') {
          const srcset = node.getAttribute('srcset') || '';
          const first = srcset.split(',')[0] || '';
          return first.trim().split(/\s+/)[0] || '';
        }
        const img = /** @type {HTMLImageElement} */ (node);
        return img.currentSrc || img.src || '';
      })
      .filter((src) => src && !src.startsWith('data:'));
    return { text, images };
  }, SELECTORS.conversation.message_assistant);
}

async function readLastAssistantText(page) {
  const { text } = await readLastAssistantPayload(page);
  return text;
}

function slugifyPrompt(prompt) {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
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

function inferImageExtension(url, contentType) {
  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('image/png')) return '.png';
  if (normalizedType.includes('image/jpeg') || normalizedType.includes('image/jpg')) return '.jpg';
  if (normalizedType.includes('image/webp')) return '.webp';
  if (normalizedType.includes('image/gif')) return '.gif';
  if (normalizedType.includes('image/avif')) return '.avif';

  const safeUrl = (() => {
    try { return new URL(url).pathname; } catch { return ''; }
  })();
  const base = basename(safeUrl || '').toLowerCase();
  const ext = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'].find((candidate) => base.endsWith(candidate));
  if (ext === '.jpeg') return '.jpg';
  return ext || '.png';
}

function isLikelyGeneratedImageUrl(rawUrl) {
  if (!rawUrl) return false;
  if (rawUrl.startsWith('blob:')) return true;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (host.includes('oaiusercontent.com') || host.includes('oaistatic.com')) return true;
  if (host === 'chatgpt.com' && parsed.pathname.includes('/backend-api/estuary/content')) {
    const id = parsed.searchParams.get('id') || '';
    return id.startsWith('file-') || id.startsWith('file_');
  }
  return false;
}

function normalizeToCandidates(rawUrls, baseUrl, source) {
  const candidates = [];
  const seen = new Set();

  for (const rawUrl of rawUrls) {
    if (!rawUrl) continue;
    const url = rawUrl.startsWith('blob:')
      ? rawUrl
      : (() => {
          try { return new URL(rawUrl, baseUrl).toString(); } catch { return ''; }
        })();
    if (!url || !isLikelyGeneratedImageUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push({ key: url, url, source });
  }

  return candidates;
}

async function collectAssistantImageCandidates(page) {
  const { images } = await readLastAssistantPayload(page);
  return normalizeToCandidates(images, page.url(), 'assistant');
}

async function collectPageImageCandidates(page) {
  const rawUrls = await page.evaluate(() => {
    const urls = [];
    for (const node of document.querySelectorAll('img, source[srcset]')) {
      if (node.tagName.toLowerCase() === 'source') {
        const srcset = node.getAttribute('srcset') || '';
        const first = srcset.split(',')[0] || '';
        const src = first.trim().split(/\s+/)[0] || '';
        if (src) urls.push(src);
        continue;
      }
      const img = /** @type {HTMLImageElement} */ (node);
      const src = img.currentSrc || img.src || '';
      if (src) urls.push(src);
    }
    return urls;
  });
  return normalizeToCandidates(rawUrls, page.url(), 'page');
}

async function collectSeenImageKeys(page) {
  const assistant = await collectAssistantImageCandidates(page);
  const allPage = await collectPageImageCandidates(page);
  return new Set([...assistant, ...allPage].map((candidate) => candidate.key));
}

async function waitForNewImageCandidates(page, seenKeys, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const assistant = await collectAssistantImageCandidates(page);
    const freshAssistant = assistant.filter((candidate) => !seenKeys.has(candidate.key));
    if (freshAssistant.length) return freshAssistant;

    const allPage = await collectPageImageCandidates(page);
    const freshPage = allPage.filter((candidate) => !seenKeys.has(candidate.key));
    if (freshPage.length) return freshPage;

    await page.waitForTimeout(1000);
  }
  return [];
}

async function readBlobImageFromPage(page, blobUrl) {
  const payload = await page.evaluate(async (url) => {
    const bytesToBase64 = (bytes) => {
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    };

    const decodeBlob = async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        base64: bytesToBase64(bytes),
        contentType: blob.type || '',
      };
    };

    const decodeBlobUrlViaCanvas = async (blobUrl) => {
      const findExistingImage = () => {
        for (const node of document.querySelectorAll('img')) {
          const img = /** @type {HTMLImageElement} */ (node);
          const src = img.currentSrc || img.src || '';
          if (src === blobUrl) return img;
        }
        return null;
      };

      const existingImage = findExistingImage();
      const image = existingImage || new Image();
      if (!existingImage) {
        image.src = blobUrl;
      }

      if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
        await new Promise((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = (event) => reject(event);
        });
      }

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, image.naturalWidth || image.width || 0);
      canvas.height = Math.max(1, image.naturalHeight || image.height || 0);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas_2d_unavailable');
      context.drawImage(image, 0, 0);

      const dataUrl = canvas.toDataURL('image/png');
      const marker = 'base64,';
      const markerIndex = dataUrl.indexOf(marker);
      if (markerIndex < 0) {
        throw new Error('canvas_data_url_missing_base64');
      }
      return {
        base64: dataUrl.slice(markerIndex + marker.length),
        contentType: 'image/png',
      };
    };

    let fetchError = null;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        fetchError = `blob fetch failed: ${response.status}`;
      } else {
        const decoded = await decodeBlob(await response.blob());
        return {
          ok: true,
          base64: decoded.base64,
          contentType: decoded.contentType || response.headers.get('content-type') || '',
        };
      }
    } catch (error) {
      fetchError = String(error);
    }

    // Some browser sessions can reject fetch(blob:...) with NetworkError.
    // Fallback to the rendered image element + canvas extraction for blob URLs.
    try {
      const decoded = await decodeBlobUrlViaCanvas(url);
      return {
        ok: true,
        base64: decoded.base64,
        contentType: decoded.contentType || '',
      };
    } catch (error) {
      const fallbackError = String(error);
      return { ok: false, error: fetchError ? `${fetchError}; fallback failed: ${fallbackError}` : fallbackError };
    }
  }, blobUrl);

  if (!payload?.ok || !payload.base64) {
    throw new Error(payload?.error || `failed to read blob url: ${blobUrl}`);
  }
  return {
    buffer: Buffer.from(payload.base64, 'base64'),
    contentType: payload.contentType || '',
  };
}

async function downloadImages(page, candidates, outputDir) {
  const request = page.context().request;
  const uniqueCandidates = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!seen.has(candidate.key)) {
      seen.add(candidate.key);
      uniqueCandidates.push(candidate);
    }
  }
  const files = [];

  for (const [index, candidate] of uniqueCandidates.entries()) {
    let buffer;
    let contentType = '';

    if (candidate.url.startsWith('blob:')) {
      const blob = await readBlobImageFromPage(page, candidate.url);
      buffer = blob.buffer;
      contentType = blob.contentType;
    } else {
      const response = await request.get(candidate.url, { timeout: 30_000 });
      if (!response.ok()) {
        throw new Error(`failed to download image ${index + 1}: ${response.status()} ${response.statusText()} (${candidate.url})`);
      }
      buffer = await response.body();
      contentType = response.headers()['content-type'] || '';
    }

    const ext = inferImageExtension(candidate.url, contentType);
    const file = join(outputDir, `${String(index + 1).padStart(2, '0')}${ext}`);
    writeFileSync(file, buffer);
    files.push(file);
  }

  return files;
}

async function sendPrompt(page, prompt, opts = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('prompt required');
  }

  await ensureReady(page);
  const prevAssistantCount = await page.locator(SELECTORS.conversation.message_assistant).count();
  await uploadAttachments(page, opts);

  const input = page.locator(SELECTORS.composer.prompt_input);
  await clearComposerInput(page, input);
  await page.keyboard.insertText(prompt);

  const send = await findReadyComposerSubmitButton(page);
  if (!send) throw new Error('composer_submit_button_not_found');
  await send.click();

  return prevAssistantCount;
}

async function sendPromptAndWait(page, prompt, opts = {}) {
  const previousUrl = page.url();
  const prevAssistantCount = await sendPrompt(page, prompt, opts);
  await bestEffortRenameConversation(page, opts.requestId, { previousUrl });
  await waitForResponse(page, prevAssistantCount, opts);
}

function notLoggedInError() {
  return new Error('not_logged_in: run `exocortex-chatgpt launch --visible` and sign in');
}

async function assertPromptCapablePage(page) {
  const promptState = await waitForPromptCapability(page, { timeoutMs: 30_000 });
  if (promptState.state === 'not_logged_in') throw notLoggedInError();
  if (promptState.state !== 'ready') throw pageNotReadyError(promptState);
}

async function newChatOnPage(page) {
  const btn = page.locator(SELECTORS.nav.new_chat_button);
  if (await btn.count()) {
    try {
      await btn.first().click({ timeout: 10_000 });
    } catch {
      await btn.first().evaluate((el) => el.click());
    }
  } else {
    await page.goto(SELECTORS.urls.home, { waitUntil: 'domcontentloaded' });
  }

  await page.waitForSelector(SELECTORS.composer.prompt_input, { timeout: 15_000 });
}

async function setModelOnPage(page, name) {
  if (!name) throw new Error('model name required');

  const dropdown = page.locator(SELECTORS.model.dropdown_button);
  await dropdown.waitFor({ state: 'visible', timeout: 10_000 });
  await dropdown.first().click();

  const menuitemSel = SELECTORS.model._menuitem_role;
  const key = name.toLowerCase().trim();
  const mappedSel = SELECTORS.model.name_map?.[key];

  const tryClick = async (locator, waitMs = 3000) => {
    try {
      await locator.waitFor({ state: 'visible', timeout: waitMs });
      await locator.click();
      return true;
    } catch {
      return false;
    }
  };

  if (mappedSel) {
    if (await tryClick(page.locator(mappedSel).first(), 3000)) {
      await page.waitForTimeout(250);
      const info = await readPillInfo(page);
      return { model: info.model };
    }
  }

  if (await tryClick(page.locator(menuitemSel, { hasText: name }).first(), 2000)) {
    await page.waitForTimeout(250);
    const info = await readPillInfo(page);
    return { model: info.model };
  }

  for (const triggerText of SELECTORS.model.submenu_trigger_text || []) {
    const trigger = page.locator(menuitemSel, { hasText: triggerText }).first();
    if (!(await trigger.count())) continue;

    await trigger.hover();
    if (await tryClick(page.locator(menuitemSel, { hasText: name }).first(), 1500)) {
      await page.waitForTimeout(250);
      const info = await readPillInfo(page);
      return { model: info.model };
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  throw new Error(`model "${name}" not found. Known: ${Object.keys(SELECTORS.model.name_map || {}).join(', ')}`);
}

async function setThinkingOnPage(page, level) {
  if (!level) throw new Error('thinking level required');

  const pill = page.locator(SELECTORS.thinking.pill_trigger);
  if (!(await pill.count())) {
    throw new Error('thinking pill not available — current model does not support thinking levels');
  }
  await pill.first().click();

  const key = level.toLowerCase().trim();
  const menuitemSel = SELECTORS.thinking.menuitem_role;

  const tryClick = async (locator, waitMs = 2000) => {
    try {
      await locator.waitFor({ state: 'visible', timeout: waitMs });
      await locator.click();
      return true;
    } catch {
      return false;
    }
  };

  const href = SELECTORS.thinking.icon_href?.[key];
  if (href) {
    const byIcon = page.locator(`${menuitemSel}:has(use[href="${href}"])`).first();
    if (await tryClick(byIcon, 2000)) {
      await page.waitForTimeout(200);
      return { level: key };
    }
  }

  const texts = SELECTORS.thinking.name_map_text?.[key] || [level];
  for (const text of texts) {
    if (await tryClick(page.locator(menuitemSel, { hasText: text }).first(), 1500)) {
      await page.waitForTimeout(200);
      return { level: key };
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  throw new Error(`thinking level "${level}" not found. Known: ${Object.keys(SELECTORS.thinking.name_map_text || {}).join(', ')}`);
}

async function queryOnPage(page, prompt, opts = {}) {
  await assertPromptCapablePage(page);

  if (opts.fresh) await newChatOnPage(page);
  if (opts.model) await setModelOnPage(page, opts.model);
  if (opts.thinking) await setThinkingOnPage(page, opts.thinking);

  await sendPromptAndWait(page, prompt, { ...opts, generatingTimeoutMs: 0 });
  let text = await readLastAssistantText(page);
  if (!text && opts.requestId) {
    try {
      if (await navigateToConversation(page, opts.requestId)) {
        text = await readLastAssistantText(page);
      }
    } catch (error) {
      log('conversation navigation recovery failed', opts.requestId, error?.message || error);
    }
  }
  return { text, files: [], key: 'default' };
}

async function generateImageOnPage(page, prompt, opts = {}) {
  await assertPromptCapablePage(page);

  if (opts.fresh) await newChatOnPage(page);
  if (opts.model) await setModelOnPage(page, opts.model);
  if (opts.thinking) await setThinkingOnPage(page, opts.thinking);

  const seenKeys = await collectSeenImageKeys(page);
  const previousUrl = page.url();
  const prevAssistantCount = await sendPrompt(page, prompt, opts);
  await bestEffortRenameConversation(page, opts.requestId, { previousUrl });
  const newCandidates = await waitForNewImageCandidates(page, seenKeys, opts.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS);

  // Best effort: gather text if an assistant turn exists, but don't fail image flow if it doesn't.
  await waitForResponse(page, prevAssistantCount, {
    assistantTimeoutMs: 10_000,
    generatingTimeoutMs: 10_000,
  }).catch(() => {});
  const payload = await readLastAssistantPayload(page);

  if (!newCandidates.length) {
    return { files: [], text: payload.text, key: 'default' };
  }

  const outputDir = resolveOutputDir(prompt, opts.output_dir || opts.outputDir);
  const files = await downloadImages(page, newCandidates, outputDir);
  return { files, text: payload.text, key: 'default' };
}

export async function queryInPage(page, prompt, opts = {}) {
  if ((opts.mode || 'text') === 'image') {
    return generateImageOnPage(page, prompt, opts);
  }
  return queryOnPage(page, prompt, opts);
}

async function _queryImpl(prompt, opts = {}) {
  const page = await getPage();
  return queryOnPage(page, prompt, opts);
}
export const query = (prompt, opts) => serialize(() => _queryImpl(prompt, opts));

async function _generateImageImpl(prompt, opts = {}) {
  const page = await getPage();
  return generateImageOnPage(page, prompt, opts);
}
export const generateImage = (prompt, opts) => serialize(() => _generateImageImpl(prompt, opts));

async function _readLastImpl() {
  const page = await getPage();
  const text = await readLastAssistantText(page);
  return { text, key: 'default' };
}
export const readLast = () => serialize(_readLastImpl);

async function _newChatImpl() {
  const page = await getPage();
  await newChatOnPage(page);
  return { key: 'default' };
}
export const newChat = () => serialize(_newChatImpl);

async function _getModelImpl() {
  const page = await getPage();
  const info = await readPillInfo(page);
  return info.model;
}
export const getModel = () => serialize(_getModelImpl);

async function _setModelImpl(name) {
  const page = await getPage();
  return setModelOnPage(page, name);
}
export const setModel = (name) => serialize(() => _setModelImpl(name));

async function _getThinkingImpl() {
  const page = await getPage();
  const info = await readPillInfo(page);
  return info.thinking;
}
export const getThinking = () => serialize(_getThinkingImpl);

async function _setThinkingImpl(level) {
  const page = await getPage();
  return setThinkingOnPage(page, level);
}
export const setThinking = (level) => serialize(() => _setThinkingImpl(level));

async function _stopImpl() {
  const page = await getPage();
  const btn = page.locator(SELECTORS.composer.stop_button);
  if (await btn.count()) await btn.first().click();
  return { stopped: true };
}
export const stop = () => serialize(_stopImpl);

export async function checkSelectors() {
  const page = await getPage();
  const report = [];

  const walk = async (obj, path) => {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue;
      const p = path ? `${path}.${k}` : k;
      if (typeof v === 'string') {
        if (p.startsWith('urls.') || p === 'model._menuitem_role') continue;
        const n = await page.locator(v).count().catch(() => -1);
        report.push({ path: p, selector: v, count: n });
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        await walk(v, p);
      }
    }
  };

  await walk(SELECTORS, '');
  return report;
}

export async function shutdown() {
  try {
    await closeOwnedEphemeralPages({ includeErrors: false });
    if (_ownsBrowser) {
      await _context?.close();
    } else {
      await disconnectAttachedBrowser(_browser);
    }
  } catch {}
  resetSessionHandles();
}
