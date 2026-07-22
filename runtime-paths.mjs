import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const LEGACY_HOME = join(homedir(), '.chatgpt-mcp');

function defaultHome() {
  return join(homedir(), '.exocortex', 'chatgpt');
}

export function getHome() {
  const exoHome = String(process.env.EXOCORTEX_HOME || '').trim();
  if (exoHome) return join(resolve(exoHome), 'chatgpt');
  return defaultHome();
}

export function getAgentName() {
  return String(process.env.MACX_AGENT || '').trim() || null;
}

export function getProfileDir() {
  const current = join(getHome(), 'profile');
  const legacy = join(LEGACY_HOME, 'profile');
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

export function getCDPFilePath() {
  const current = join(getHome(), 'cdp');
  const legacy = join(LEGACY_HOME, 'cdp');
  if (!existsSync(current) && existsSync(legacy)) return legacy;
  return current;
}

export function getImagesDir() {
  return join(getHome(), 'images');
}

export function getRequestsDir() {
  return join(getHome(), 'requests');
}

export function getResponsesDir() {
  return join(getHome(), 'responses');
}

export function getDaemonPidPath() {
  return join(getHome(), 'daemon.pid');
}

export function getTokenPath() {
  return join(getHome(), 'token');
}
