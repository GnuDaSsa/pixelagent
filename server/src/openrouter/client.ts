export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface OpenRouterChatOptions {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface OpenRouterChatResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

interface OpenRouterStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function streamOpenRouterChat(
  options: OpenRouterChatOptions,
): Promise<OpenRouterChatResult> {
  const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      'X-OpenRouter-Title': 'Pixel Agents',
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
      usage: { include: true },
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `OpenRouter request failed (${response.status}): ${text || response.statusText}`,
    );
  }

  if (!response.body) {
    throw new Error('OpenRouter response did not include a stream body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (!data || data === '[DONE]') continue;

      let chunk: OpenRouterStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenRouterStreamChunk;
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        options.onDelta?.(delta);
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
    }
  }

  return { content, inputTokens, outputTokens };
}
