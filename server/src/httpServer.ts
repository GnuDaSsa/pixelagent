import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { AssetCache, SetHooksEnabledSideEffect } from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import { HOOK_API_PREFIX, MAX_HOOK_BODY_SIZE } from './constants.js';
import type { OpenRouterAgentRuntime } from './openrouter/runtime.js';
import type { AgentState } from './types.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** API-backed agent runtime. */
  openRouterRuntime?: OpenRouterAgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();
const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_PROXY_BODY_LIMIT = 4 * 1024 * 1024;

interface OpenRouterProxyBody {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  stream?: boolean;
  metadata?: {
    pixelAgentSession?: string;
    pixelAgentName?: string;
    pixelAgentProfile?: string;
  };
  user?: string;
}

interface ProxyAgentMeta {
  sessionKey: string;
  displayName: string;
  profileId?: string;
  model?: string;
}

const proxyAgentIds = new Map<string, number>();

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    logger: !options.embedded,
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  registerHealthRoute(app);
  registerHookRoute(app, options);
  registerOpenRouterProxyRoute(app, options);
  registerWebSocketRoute(app, options);

  // ── Listen ──────────────────────────────────────────────────

  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    pid: process.pid,
  }));
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: bearerAuth(options.token),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerOpenRouterProxyRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.post<{ Body: OpenRouterProxyBody }>(
    '/api/openrouter/v1/chat/completions',
    { bodyLimit: OPENROUTER_PROXY_BODY_LIMIT },
    async (request, reply) => {
      if (!options.openRouterRuntime) {
        reply.code(503).send({ error: { message: 'OpenRouter runtime is not available.' } });
        return;
      }

      const body = request.body ?? {};
      const apiKey = resolveOpenRouterApiKey(request);
      if (!apiKey) {
        reply.code(401).send({
          error: {
            message:
              'OPENROUTER_API_KEY is not set on the Pixel Agents server and no bearer key was provided.',
          },
        });
        return;
      }

      const meta = getProxyAgentMeta(request, body);
      const agentId = getOrCreateProxyAgent(options, meta);
      const toolId = beginProxyRun(options.store, agentId, body.model);

      try {
        const upstream = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-OpenRouter-Title': 'Pixel Agents',
          },
          body: JSON.stringify(body),
        });

        if (body.stream) {
          await forwardStreamingOpenRouterResponse(upstream, reply, options.store, agentId, toolId);
          return;
        }

        await forwardJsonOpenRouterResponse(upstream, reply, options.store, agentId, toolId);
      } catch (err) {
        failProxyRun(
          options.store,
          agentId,
          toolId,
          err instanceof Error ? err.message : String(err),
        );
        reply.code(502).send({
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );
}

function resolveOpenRouterApiKey(request: FastifyRequest): string | null {
  const serverKey = process.env['OPENROUTER_API_KEY']?.trim();
  if (serverKey) return serverKey;

  const auth = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] : auth);
  const headerKey = match?.[1]?.trim();
  if (!headerKey || headerKey.toLowerCase() === 'dummy') return null;
  return headerKey;
}

function getProxyAgentMeta(request: FastifyRequest, body: OpenRouterProxyBody): ProxyAgentMeta {
  const header = (name: string) => {
    const value = request.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  const sessionKey =
    header('x-pixel-agent-session') ||
    header('x-pixel-session-id') ||
    body.metadata?.pixelAgentSession ||
    body.user ||
    'default';

  const displayName =
    header('x-pixel-agent-name') || body.metadata?.pixelAgentName || '오픈라우터 API';

  const profileId = header('x-pixel-agent-profile') || body.metadata?.pixelAgentProfile;

  return {
    sessionKey,
    displayName,
    profileId,
    model: body.model,
  };
}

function getOrCreateProxyAgent(options: HttpServerOptions, meta: ProxyAgentMeta): number {
  const existingId = proxyAgentIds.get(meta.sessionKey);
  if (existingId !== undefined && options.store.has(existingId)) {
    return existingId;
  }

  const id = options.openRouterRuntime!.createAgent({
    displayName: meta.displayName,
    profileId: meta.profileId ?? 'api-proxy',
    model: meta.model,
  });
  proxyAgentIds.set(meta.sessionKey, id);
  return id;
}

function beginProxyRun(store: AgentStateStore, agentId: number, model?: string): string {
  const agent = store.get(agentId);
  const toolId = `openrouter-proxy-${Date.now()}`;
  if (agent) {
    agent.model = model ?? agent.model;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, 'working');
    agent.activeToolNames.set(toolId, '오픈라우터');
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
    agent.lastDataAt = Date.now();
  }
  store.broadcast({
    type: 'agentToolStart',
    id: agentId,
    toolId,
    status: 'working',
    toolName: '오픈라우터',
  });
  store.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
  return toolId;
}

function finishProxyRun(
  store: AgentStateStore,
  agentId: number,
  toolId: string,
  content: string,
  inputTokens = 0,
  outputTokens = 0,
): void {
  const agent = store.get(agentId);
  if (agent) {
    agent.activeToolIds.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    agent.activeToolNames.delete(toolId);
    agent.isWaiting = true;
    agent.hadToolsInTurn = false;
    agent.inputTokens += inputTokens;
    agent.outputTokens += outputTokens;
    if (inputTokens > 0 || outputTokens > 0) {
      store.broadcast({
        type: 'agentTokenUsage',
        id: agentId,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }
  }
  store.broadcast({ type: 'agentToolDone', id: agentId, toolId });
  store.broadcast({ type: 'agentTextDone', id: agentId, content });
  store.broadcast({ type: 'agentToolsClear', id: agentId });
  store.broadcast({ type: 'agentStatus', id: agentId, status: 'waiting', awaitingInput: false });
  store.persist();
}

function failProxyRun(
  store: AgentStateStore,
  agentId: number,
  toolId: string,
  message: string,
): void {
  store.broadcast({ type: 'agentRunError', id: agentId, message });
  finishProxyRun(store, agentId, toolId, '', 0, 0);
}

async function forwardJsonOpenRouterResponse(
  upstream: Response,
  reply: FastifyReply,
  store: AgentStateStore,
  agentId: number,
  toolId: string,
): Promise<void> {
  const text = await upstream.text();
  reply.code(upstream.status);
  reply.header('content-type', upstream.headers.get('content-type') ?? 'application/json');

  if (!upstream.ok) {
    failProxyRun(store, agentId, toolId, `OpenRouter request failed (${upstream.status})`);
    reply.send(text);
    return;
  }

  const parsed = tryParseJson(text);
  const content = extractOpenRouterContent(parsed);
  const usage = extractOpenRouterUsage(parsed);
  finishProxyRun(store, agentId, toolId, content, usage.inputTokens, usage.outputTokens);
  reply.send(text);
}

async function forwardStreamingOpenRouterResponse(
  upstream: Response,
  reply: FastifyReply,
  store: AgentStateStore,
  agentId: number,
  toolId: string,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.statusCode = upstream.status;
  res.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/event-stream');
  res.setHeader('cache-control', upstream.headers.get('cache-control') ?? 'no-cache');

  if (!upstream.body) {
    failProxyRun(store, agentId, toolId, 'OpenRouter response did not include a stream body');
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice('data:'.length).trim();
        if (!data || data === '[DONE]') continue;
        const parsed = tryParseJson(data);
        const delta = extractOpenRouterDelta(parsed);
        if (delta) {
          content += delta;
          store.broadcast({ type: 'agentTextDelta', id: agentId, delta });
        }
        const usage = extractOpenRouterUsage(parsed);
        inputTokens = usage.inputTokens || inputTokens;
        outputTokens = usage.outputTokens || outputTokens;
      }
    }

    if (!upstream.ok) {
      failProxyRun(store, agentId, toolId, `OpenRouter request failed (${upstream.status})`);
    } else {
      finishProxyRun(store, agentId, toolId, content, inputTokens, outputTokens);
    }
  } finally {
    res.end();
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractOpenRouterDelta(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const choices = (value as { choices?: Array<{ delta?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.delta?.content;
  return typeof content === 'string' ? content : '';
}

function extractOpenRouterContent(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const choices = (value as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function extractOpenRouterUsage(value: unknown): { inputTokens: number; outputTokens: number } {
  if (!value || typeof value !== 'object') return { inputTokens: 0, outputTokens: 0 };
  const usage = (
    value as {
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    }
  ).usage;
  return {
    inputTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    outputTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0,
  };
}

function registerWebSocketRoute(app: FastifyInstance, options: HttpServerOptions): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // In standalone mode (not embedded), skip auth for WebSocket connections.
    // The server binds to 127.0.0.1, so only local clients can connect.
    // In embedded mode (VS Code), require Bearer token for security.
    if (options.embedded) {
      const auth = request.headers.authorization ?? '';
      const expected = `Bearer ${options.token}`;
      const authBuf = Buffer.from(auth);
      const expectedBuf = Buffer.from(expected);
      if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
        socket.close(4001, 'unauthorized');
        return;
      }
    }

    const { store } = options;

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        folderName: agent.folderName,
        isExternal: agent.isExternal || undefined,
        providerId: agent.providerId ?? 'claude',
        providerLabel: agent.providerLabel ?? 'Claude',
        displayName: agent.displayName,
        profileId: agent.profileId,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
      });
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!options.embedded && msg.type) {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        handleClientMessage(msg, (m) => safeSend(socket, m), {
          store,
          runtime: options.runtime,
          openRouterRuntime: options.openRouterRuntime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
    });
  });
}

// ── Auth Helper ────────────────────────────────────────────────

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization ?? '';
    const expected = `Bearer ${expectedToken}`;
    const authBuf = Buffer.from(auth);
    const expectedBuf = Buffer.from(expected);
    if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
