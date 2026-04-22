import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
  return join(getHome(), 'profile');
}

export function getCDPFilePath() {
  return join(getHome(), 'cdp');
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
