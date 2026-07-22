#!/usr/bin/env node
// Shared MCP server over Streamable HTTP for exocortex-chatgpt-connector.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerMcpTools } from './mcp-tools.mjs';

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '8766', 10);
const ENDPOINT = '/mcp';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`invalid PORT: ${process.env.PORT}`);
}

const sessions = new Map();

function createMcpServer() {
  const server = new McpServer({ name: 'exocortex-chatgpt', version: '0.1.1' });
  registerMcpTools(server);
  return server;
}

async function createSession() {
  const session = {};
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessionclosed: sessionId => {
      sessions.delete(sessionId);
    },
    onsessioninitialized: sessionId => {
      sessions.set(sessionId, session);
    },
  });
  const server = createMcpServer();
  session.server = server;
  session.transport = transport;
  await server.connect(transport);
  return session;
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (session) {
    await session.server.close();
  }
}

function writeText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (url.pathname === '/health') {
      writeText(res, 200, 'ok\n');
      return;
    }
    if (url.pathname !== ENDPOINT) {
      writeText(res, 404, `not found; MCP endpoint is ${ENDPOINT}\n`);
      return;
    }

    if (req.method !== 'POST' && req.headers['mcp-session-id'] === undefined) {
      writeText(res, 400, 'MCP session id is required\n');
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const normalizedSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    const session = normalizedSessionId ? sessions.get(normalizedSessionId) : await createSession();

    if (!session) {
      writeText(res, 404, 'MCP session not found\n');
      return;
    }

    await session.transport.handleRequest(req, res);

    if (!normalizedSessionId && !session.transport.sessionId) {
      await session.server.close();
    }

    if (req.method === 'DELETE' && normalizedSessionId) {
      await closeSession(normalizedSessionId);
    }
  } catch (error) {
    console.error('[mcp-http] request error:', error);
    if (!res.headersSent) {
      writeText(res, 500, 'internal server error\n');
    } else {
      res.destroy(error);
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(`[mcp-http] exocortex-chatgpt listening at http://${HOST}:${PORT}${ENDPOINT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    httpServer.close();
    await Promise.allSettled(Array.from(sessions.values(), session => session.server.close()));
    process.exit(0);
  });
}
