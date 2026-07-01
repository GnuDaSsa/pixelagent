const ACTIVITY_TEXT: Record<string, string> = {
  'Waiting for input': '입력 대기 중',
  'Needs approval': '승인 필요',
  Subtask: '하위 작업',
  Idle: '대기 중',
  Thinking: '생각 중',
  'OpenRouter API request': 'working',
  '오픈라우터 API 요청 중': 'working',
  'Searching files': '파일 검색 중',
  'Searching code': '코드 검색 중',
  'Fetching web content': '웹 내용 가져오는 중',
  'Searching the web': '웹 검색 중',
  'Running subtask': '하위 작업 실행 중',
  'Waiting for your answer': '답변 대기 중',
  Planning: '계획 중',
  'Editing notebook': '노트북 수정 중',
  'Creating team': '팀 생성 중',
  'Sending message': '메시지 전송 중',
};

const DISPLAY_NAMES: Record<string, string> = {
  'OpenRouter Agent': '오픈라우터 에이전트',
  'OpenRouter API': '오픈라우터 API',
  ComplaintAnalyzer: '민원 분석가',
  TriageAgent: '민원 분류 담당',
  LegalQueryAgent: '법령 근거 탐색',
  DraftAnswerAgent: '답변 초안 작성',
  QualityCheckAgent: '품질 검토',
};

export function localizeActivityText(text: string): string {
  const exact = ACTIVITY_TEXT[text];
  if (exact) return exact;

  const prefixed = [
    [/^Reading (.*)$/u, '읽는 중'],
    [/^Editing (.*)$/u, '수정 중'],
    [/^Writing (.*)$/u, '작성 중'],
    [/^Running: (.*)$/u, '실행 중'],
    [/^Subtask: (.*)$/u, '하위 작업'],
    [/^Creating team: (.*)$/u, '팀 생성 중'],
    [/^Using (.*)$/u, '사용 중'],
  ] as const;

  for (const [pattern, label] of prefixed) {
    const match = pattern.exec(text);
    if (match) return `${label}: ${match[1]}`;
  }

  if (text.startsWith('-> ')) return `메시지 전송 중: ${text.slice(3)}`;
  return text;
}

export function localizeDisplayName(name: string | null | undefined): string | null {
  if (!name) return null;
  return DISPLAY_NAMES[name] ?? name;
}

export function localizeProviderLabel(
  label: string | null | undefined,
  providerId?: string,
): string | null {
  const value = label || (providerId === 'openrouter' ? 'OpenRouter' : 'Claude');
  if (value === 'OpenRouter') return '오픈라우터';
  if (value === 'Claude') return '클로드';
  if (value === 'Claude Code') return '클로드 코드';
  return value;
}
