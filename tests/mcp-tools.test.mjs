import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerMcpTools } from '../mcp-tools.mjs';

function makeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, _cfg, handler) {
      tools.set(name, handler);
    },
  };
}

test('submit_pro routes to model=pro thinking=extended mode=text', async () => {
  const calls = [];
  const server = makeServer();

  registerMcpTools(server, {
    ensureDaemonRunning: async () => {},
    submit: async (prompt, opts) => {
      calls.push({ prompt, opts });
      return { request_id: 'rid-pro', response_path: '/tmp/rid-pro.json', image_dir: '/tmp/ignore' };
    },
  });

  const handler = server.tools.get('submit_pro');
  assert.ok(handler, 'submit_pro should be registered');

  const out = await handler({ prompt: 'deep work', agent: 'alpha', fresh: false });
  assert.deepEqual(calls, [{
    prompt: 'deep work',
    opts: { agent: 'alpha', model: 'pro', thinking: 'extended', mode: 'text', fresh: false },
  }]);

  assert.deepEqual(JSON.parse(out.content[0].text), {
    request_id: 'rid-pro',
    response_path: '/tmp/rid-pro.json',
  });
});

test('submit_image routes to model=pro mode=image fresh=true', async () => {
  const calls = [];
  const server = makeServer();

  registerMcpTools(server, {
    ensureDaemonRunning: async () => {},
    sessionStatus: async () => ({ state: 'ready' }),
    submit: async (prompt, opts) => {
      calls.push({ prompt, opts });
      return { request_id: 'rid-img', response_path: '/tmp/rid-img.json', image_dir: '/tmp/images/rid-img' };
    },
  });

  const handler = server.tools.get('submit_image');
  assert.ok(handler, 'submit_image should be registered');

  const out = await handler({ prompt: 'draw icon', agent: 'beta', output_dir: '/tmp/images' });
  assert.deepEqual(calls, [{
    prompt: 'draw icon',
    opts: { agent: 'beta', model: 'pro', mode: 'image', output_dir: '/tmp/images', fresh: true },
  }]);

  assert.deepEqual(JSON.parse(out.content[0].text), {
    request_id: 'rid-img',
    image_dir: '/tmp/images/rid-img',
  });
});

test('submit_image fails before queueing when session is logged out', async () => {
  const calls = [];
  const server = makeServer();

  registerMcpTools(server, {
    ensureDaemonRunning: async () => {},
    sessionStatus: async () => ({ state: 'not_logged_in' }),
    submit: async () => {
      calls.push('submit');
      return { request_id: 'rid-img', image_dir: '/tmp/images/rid-img' };
    },
  });

  const handler = server.tools.get('submit_image');
  await assert.rejects(
    () => handler({ prompt: 'draw icon' }),
    /not_logged_in/,
  );
  assert.deepEqual(calls, []);
});

test('MCP tools pass optional attachments through', async () => {
  const calls = [];
  const server = makeServer();
  const images = ['/tmp/reference.png'];
  const files = ['/tmp/example.js'];

  registerMcpTools(server, {
    ensureDaemonRunning: async () => {},
    sessionStatus: async () => ({ state: 'ready' }),
    queuedQuery: async (prompt, opts) => {
      calls.push({ tool: 'query', prompt, opts });
      return { text: 'ok' };
    },
    submit: async (prompt, opts) => {
      calls.push({ tool: opts.mode === 'image' ? 'submit_image' : 'submit_pro', prompt, opts });
      return { request_id: `rid-${calls.length}`, response_path: '/tmp/response.json', image_dir: '/tmp/images' };
    },
  });

  await server.tools.get('query')({ prompt: 'inspect this', images, files });
  await server.tools.get('submit_pro')({ prompt: 'deep work', images, files });
  await server.tools.get('submit_image')({ prompt: 'draw this', images, files });

  assert.deepEqual(calls[0].opts.images, images);
  assert.deepEqual(calls[0].opts.files, files);
  assert.deepEqual(calls[1].opts.images, images);
  assert.deepEqual(calls[1].opts.files, files);
  assert.deepEqual(calls[2].opts.images, images);
  assert.deepEqual(calls[2].opts.files, files);
});

test('legacy submit tool is not registered in MCP surface', async () => {
  const server = makeServer();
  registerMcpTools(server, {});
  assert.equal(server.tools.has('submit'), false);
});
