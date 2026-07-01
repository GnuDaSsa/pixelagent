import * as crypto from 'crypto';
import * as os from 'os';

import type { AgentStateStore } from '../agentStateStore.js';
import type { AgentState } from '../types.js';
import type { OpenRouterMessage } from './client.js';
import { streamOpenRouterChat } from './client.js';

export interface CreateOpenRouterAgentOptions {
  cwd?: string;
  displayName?: string;
  profileId?: string;
  model?: string;
}

interface OpenRouterSession {
  agentId: number;
  model: string;
  messages: OpenRouterMessage[];
  abortController?: AbortController;
}

const DEFAULT_MODEL = 'openrouter/auto';

export class OpenRouterAgentRuntime {
  private readonly sessions = new Map<number, OpenRouterSession>();

  constructor(private readonly store: AgentStateStore) {}

  createAgent(options: CreateOpenRouterAgentOptions = {}): number {
    const id = this.store.nextAgentId.current++;
    const sessionId = `openrouter-${crypto.randomUUID()}`;
    const model = options.model || process.env['OPENROUTER_MODEL'] || DEFAULT_MODEL;
    const cwd = options.cwd || process.cwd?.() || os.homedir();
    const displayName = options.displayName || '오픈라우터 에이전트';

    const agent: AgentState = {
      id,
      sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir: cwd,
      jsonlFile: '',
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: true,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: true,
      hooksOnly: true,
      providerId: 'openrouter',
      providerLabel: '오픈라우터',
      displayName,
      profileId: options.profileId,
      model,
      inputTokens: 0,
      outputTokens: 0,
    };

    this.sessions.set(id, {
      agentId: id,
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are an API-backed coding agent shown inside Pixel Agents. Be concise, practical, and explain what you are doing.',
        },
      ],
    });

    this.store.set(id, agent);
    this.store.persist();
    return id;
  }

  closeAgent(agentId: number): void {
    this.sessions.get(agentId)?.abortController?.abort();
    this.sessions.delete(agentId);
    this.store.delete(agentId);
    this.store.persist();
  }

  async sendTask(agentId: number, input: string): Promise<void> {
    const agent = this.store.get(agentId);
    if (!agent || agent.providerId !== 'openrouter') return;

    const session = this.sessions.get(agentId);
    if (!session) {
      this.store.broadcast({
        type: 'agentRunError',
        id: agentId,
        message: 'OpenRouter session was not found.',
      });
      return;
    }

    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      this.store.broadcast({
        type: 'agentRunError',
        id: agentId,
        message: 'OPENROUTER_API_KEY is not set.',
      });
      this.markWaiting(agentId, true);
      return;
    }

    const trimmed = input.trim();
    if (!trimmed) return;

    session.abortController?.abort();
    session.abortController = new AbortController();
    session.messages.push({ role: 'user', content: trimmed });

    const toolId = `openrouter-run-${Date.now()}`;
    agent.activeToolIds.add(toolId);
    agent.activeToolStatuses.set(toolId, '생각 중');
    agent.activeToolNames.set(toolId, '오픈라우터');
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
    agent.lastDataAt = Date.now();

    this.store.broadcast({
      type: 'agentToolStart',
      id: agentId,
      toolId,
      status: '생각 중',
      toolName: '오픈라우터',
    });
    this.store.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });

    try {
      let content = '';
      const result = await streamOpenRouterChat({
        apiKey,
        model: session.model,
        messages: session.messages,
        signal: session.abortController.signal,
        onDelta: (delta) => {
          content += delta;
          this.store.broadcast({ type: 'agentTextDelta', id: agentId, delta });
        },
      });
      content = result.content || content;
      session.messages.push({ role: 'assistant', content });
      agent.inputTokens += result.inputTokens;
      agent.outputTokens += result.outputTokens;
      if (result.inputTokens > 0 || result.outputTokens > 0) {
        this.store.broadcast({
          type: 'agentTokenUsage',
          id: agentId,
          inputTokens: agent.inputTokens,
          outputTokens: agent.outputTokens,
        });
      }
      this.store.broadcast({ type: 'agentToolDone', id: agentId, toolId });
      this.store.broadcast({ type: 'agentTextDone', id: agentId, content });
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') {
        this.store.broadcast({
          type: 'agentRunError',
          id: agentId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      this.store.broadcast({ type: 'agentToolsClear', id: agentId });
      this.markWaiting(agentId, false);
      session.abortController = undefined;
      this.store.persist();
    }
  }

  private markWaiting(agentId: number, awaitingInput: boolean): void {
    const agent = this.store.get(agentId);
    if (agent) {
      agent.isWaiting = true;
      agent.permissionSent = false;
      agent.hadToolsInTurn = false;
    }
    this.store.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
      awaitingInput,
    });
  }
}
