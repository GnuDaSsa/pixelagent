import { useEffect, useMemo, useRef } from 'react';

import { localizeDisplayName, localizeProviderLabel } from '../localization.js';
import type { OfficeState } from '../office/engine/officeState.js';

interface WorkLogPanelProps {
  agents: number[];
  officeState: OfficeState;
  workLogs: Record<number, string[]>;
  transcripts: Record<number, string>;
  errors: Record<number, string>;
}

function shortText(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}

export function WorkLogPanel({
  agents,
  officeState,
  workLogs,
  transcripts,
  errors,
}: WorkLogPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const agentSummaries = useMemo(
    () =>
      agents
        .map((id) => {
          const ch = officeState.characters.get(id);
          const name = localizeDisplayName(
            ch?.displayName ||
              ch?.agentName ||
              (ch?.providerId === 'openrouter' ? 'OpenRouter Agent' : `Agent ${id}`),
          );
          const provider = localizeProviderLabel(ch?.providerLabel, ch?.providerId);
          const logs = workLogs[id] ?? [];
          const transcript = transcripts[id] ? shortText(transcripts[id]) : '';
          const error = errors[id] ? shortText(errors[id], 120) : '';
          return { id, name, provider, logs, transcript, error };
        })
        .filter((agent) => agent.logs.length > 0 || agent.transcript || agent.error),
    [agents, errors, officeState.characters, transcripts, workLogs],
  );

  useEffect(() => {
    const el = panelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agentSummaries]);

  return (
    <aside className="absolute top-10 right-10 z-20 pixel-panel p-5 w-250 max-w-[calc(100%-20px)] max-h-[52vh] flex flex-col gap-4">
      <div className="flex items-center justify-between gap-6">
        <div className="text-sm text-accent-bright leading-none">작업 로그</div>
        <div className="text-2xs text-text-muted leading-none">{agentSummaries.length}명</div>
      </div>

      <div ref={panelRef} className="overflow-auto pr-2 flex flex-col gap-5 text-xs leading-tight">
        {agentSummaries.length === 0 ? (
          <div className="text-text-muted">아직 받은 작업이 없습니다.</div>
        ) : (
          agentSummaries.map((agent) => (
            <section
              key={agent.id}
              className="border-t-2 border-border pt-4 first:border-t-0 first:pt-0"
            >
              <div className="flex items-center justify-between gap-5 mb-2">
                <div className="text-text overflow-hidden text-ellipsis whitespace-nowrap">
                  {agent.name}
                </div>
                {agent.provider && (
                  <div className="text-2xs text-text-muted shrink-0">{agent.provider}</div>
                )}
              </div>
              <div className="flex flex-col gap-2 text-text-muted">
                {agent.logs.slice(-5).map((line, index) => (
                  <div key={`${agent.id}-${index}`}>{line}</div>
                ))}
                {agent.transcript && <div className="text-text">응답: {agent.transcript}</div>}
                {agent.error && <div className="text-danger">오류: {agent.error}</div>}
              </div>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
