import { z } from 'zod';
import {
  status as sessionStatus,
} from './browser-controller.mjs';
import {
  ensureDaemonRunning,
  fetch as fetchRequest,
  query as queuedQuery,
  status as requestStatus,
  submit,
} from './mailbox.mjs';

const attachmentSchema = {
  images: z.array(z.string()).optional().describe('Absolute file paths to image attachments (png, jpg, webp). Use for: reference screenshots, UI mockups, design inspiration, diagrams. ChatGPT sees these as visual context alongside your text prompt.'),
  files: z.array(z.string()).optional().describe('Absolute file paths to text/code file attachments. Use for: source code for review, config files, data samples, specs. ChatGPT reads these as context alongside your text prompt.'),
};

function withAttachments(opts, images, files) {
  return {
    ...opts,
    ...(images !== undefined ? { images } : {}),
    ...(files !== undefined ? { files } : {}),
  };
}

async function assertSubmitSessionReady(sessionStatus) {
  const s = await sessionStatus();
  if (s?.state === 'not_logged_in') {
    throw new Error('not_logged_in: run `exocortex-chatgpt launch --visible` and sign in');
  }
  if (s?.state === 'loading') {
    throw new Error(`chatgpt_page_not_ready: ${s.reason || 'ChatGPT page is still loading'}`);
  }
  if (s?.state === 'error') {
    throw new Error(`chatgpt_session_error: ${s.error || 'unable to inspect ChatGPT session'}`);
  }
}

export function registerMcpTools(server, deps = {}) {
  const d = {
    sessionStatus,
    ensureDaemonRunning,
    fetchRequest,
    queuedQuery,
    requestStatus,
    submit,
    ...deps,
  };

  server.registerTool('query', {
    title: 'Send a prompt to ChatGPT',
    description: 'BLOCKING up to 30min. Agents prefer submit_pro (non-blocking, Pro-routed). This sync tool is for CLI and interactive single-user use. Sends a prompt and waits for completion. Uses submit+poll+fetch under the hood.',
    inputSchema: {
      prompt: z.string().min(1),
      fresh: z.boolean().optional().describe('Start a new chat before sending.'),
      model: z.string().optional().describe('Switch to this model first (matches by visible name).'),
      thinking: z.string().optional().describe('Thinking level: "standard" or "longer" (Pro/Thinking models only).'),
      agent: z.string().optional().describe('Agent label used for async request ownership.'),
      mode: z.enum(['text', 'image']).optional().describe('Response mode. Use "image" to wait for downloaded image files. Image mode defaults to Pro routing unless the caller specifies another model.'),
      output_dir: z.string().optional().describe('Optional output directory for image downloads when mode=image.'),
      ...attachmentSchema,
      key: z.string().optional(),
    },
  }, async ({ prompt, fresh, model, thinking, agent, mode, output_dir, images, files }) => {
    const result = await d.queuedQuery(prompt, withAttachments({ fresh, model, thinking, agent, mode, output_dir }, images, files));
    if ((mode || 'text') === 'image') {
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    return { content: [{ type: 'text', text: result.text }] };
  });

  server.registerTool('submit_pro', {
    title: 'Submit async GPT-5 Pro request',
    description: 'Submit heavy-reasoning prompt to GPT-5 Pro (Extended Pro). Returns immediately with { request_id, response_path }. File at response_path will contain the text response when ready (typically 30s–30min). Use this for: architecture decisions, debugging hard problems, deep analysis, spec writing. Supports image and file attachments for visual references and code context. Agents: combine with sleep to avoid wasting context while waiting.',
    inputSchema: {
      prompt: z.string().min(1),
      agent: z.string().optional().describe('Agent label to notify when response is ready.'),
      fresh: z.boolean().optional().describe('Start a new chat in the worker tab before sending.'),
      ...attachmentSchema,
      key: z.string().optional(),
    },
  }, async ({ prompt, agent, fresh, images, files }) => {
    await d.ensureDaemonRunning();
    const result = await d.submit(prompt, withAttachments({ agent, model: 'pro', thinking: 'extended', mode: 'text', fresh }, images, files));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ request_id: result.request_id, response_path: result.response_path }),
      }],
    };
  });

  server.registerTool('submit_image', {
    title: 'Submit async Pro image request',
    description: 'Submit image-generation prompt to ChatGPT Pro. Returns immediately with { request_id, image_dir }. PNG files appear in image_dir when ready (typically 30s–3min). Use for: UI assets, carousel imagery, illustrations, mockups, sprite sheets. Attach reference images via the images parameter to guide style/composition.',
    inputSchema: {
      prompt: z.string().min(1),
      agent: z.string().optional().describe('Agent label to notify when images are ready.'),
      output_dir: z.string().optional().describe('Optional output directory for image downloads.'),
      ...attachmentSchema,
      key: z.string().optional(),
    },
  }, async ({ prompt, agent, output_dir, images, files }) => {
    await d.ensureDaemonRunning();
    await assertSubmitSessionReady(d.sessionStatus);
    const result = await d.submit(prompt, withAttachments({ agent, model: 'pro', mode: 'image', output_dir, fresh: true }, images, files));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ request_id: result.request_id, image_dir: result.image_dir }),
      }],
    };
  });

  server.registerTool('status', {
    title: 'ChatGPT status',
    description: 'Without request_id: session status {state, model, thinking}. With request_id: async status {state, agent, elapsed_ms, error?}.',
    inputSchema: {
      request_id: z.string().optional(),
      key: z.string().optional(),
    },
  }, async ({ request_id }) => {
    if (request_id) {
      const s = await d.requestStatus(request_id);
      return { content: [{ type: 'text', text: JSON.stringify(s) }] };
    }

    const s = await d.sessionStatus();
    return { content: [{ type: 'text', text: JSON.stringify(s) }] };
  });

  server.registerTool('fetch', {
    title: 'Fetch async request result',
    description: 'Returns {text, files[], complete, error?} for a queued request.',
    inputSchema: {
      request_id: z.string().min(1),
      key: z.string().optional(),
    },
  }, async ({ request_id }) => {
    const payload = await d.fetchRequest(request_id);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  });
}
