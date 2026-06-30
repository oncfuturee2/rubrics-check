import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Copy, Plus, RefreshCw, Settings, Trash2, X } from 'lucide-react';
import { gsap } from 'gsap';
import defaultQcPrecheckTemplate from '../prompt.md?raw';
import defaultLabelGenerateTemplate from '../prompt-label.md?raw';

const AI_SETTINGS_KEY = 'rubrics-ai-assist.v1';
const DEFAULT_ACTIVE_PROFILE_ID = 'openai-compatible';
let preferRemoteSettings = false;

const DEFAULT_PROFILES = [
  {
    id: 'openai-responses',
    name: 'OpenAI Responses',
    mode: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 1800,
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI兼容',
    mode: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 1800,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    mode: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-latest',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 1800,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    mode: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 1800,
  },
  {
    id: 'ollama',
    name: 'Ollama本地',
    mode: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5:7b',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 1800,
  },
];

const LEGACY_GENERATE_PROMPT = [
  '你是专业的前端游戏/网页标注员。请根据 prompt 预生成可评分的 Rubrics。',
  '要求：',
  '- 每条 rubric 只检查一件明确可验证的事情',
  '- 不写“美观、友好、流畅”等主观项',
  '- 覆盖 prompt 的核心玩法、交互、视觉、语言、技术框架等明确要求',
  '- 输出 4 到 10 条',
  '- 只输出编号列表，格式为：1. xxx',
  '',
  'prompt:',
  '```',
  '&{prompt}',
  '```',
].join('\n');

const LEGACY_PRECHECK_PROMPT = [
  '你是严谨的 Rubrics 质检助手。请根据 prompt 检查 rubrics 是否符合任务要求和评分标准。',
  '只输出需要修改的问题；如果没有问题，只输出“合格”。',
  '输出格式必须为 Markdown 无序列表，具体到条目时使用：',
  '- 第n条rubrics -> 问题描述',
  '',
  'prompt:',
  '```',
  '&{prompt}',
  '```',
  '',
  'rubrics:',
  '```',
  '&{rubrics}',
  '```',
].join('\n');

const DEFAULT_PROMPTS = {
  precheck: defaultQcPrecheckTemplate.trim(),
  generate: defaultLabelGenerateTemplate.trim(),
};

export const AI_SETTINGS_CHANGED_EVENT = 'rubrics-ai-settings-changed';
export const AI_NOTIFICATION_EVENT = 'rubrics-ai-notification';

const DEFAULT_GITHUB_CONFIG = {
  enabled: true,
  owner: 'oncfuturee2',
  repo: 'rubrics-check',
  branch: 'main',
  precheckPath: 'prompt.md',
  generatePath: 'prompt-label.md',
  token: '',
};

const PROMPT_KIND_LABELS = {
  precheck: '质检提示词',
  generate: '标注提示词',
};

const MODE_LABELS = {
  'openai-responses': 'OpenAI Responses',
  'openai-chat': 'OpenAI兼容 Chat',
  anthropic: 'Anthropic Messages',
  gemini: 'Gemini',
  ollama: 'Ollama Chat',
};

function FieldTitle({ children, required = false, optional = false, unsupported = false }) {
  return (
    <span className="ai-field-title">
      {children}
      {required && <b className="field-required">必填</b>}
      {optional && <b className="field-optional">可选</b>}
      {unsupported && <b className="field-unsupported">不支持</b>}
    </span>
  );
}

function isOpenAiReasoningModel(model) {
  return /^(?:o\d|o-|gpt-5)/i.test(String(model || '').trim());
}

function getProfileCapabilities(profile) {
  const mode = profile?.mode || 'openai-chat';
  const openAiReasoningModel = ['openai-responses', 'openai-chat'].includes(mode) && isOpenAiReasoningModel(profile?.model);
  return {
    requiresBaseUrl: true,
    requiresApiKey: mode !== 'ollama',
    requiresModel: true,
    supportsApiKey: mode !== 'ollama',
    supportsTemperature: !openAiReasoningModel,
    supportsMaxTokens: true,
    temperatureHint: openAiReasoningModel
      ? '当前模型通常不支持 temperature 参数，已关闭且请求时不会发送。'
      : '越低越稳定，质检和标注建议 0.1 到 0.3。',
    apiKeyHint:
      mode === 'ollama'
        ? 'Ollama 本地模式不使用 API Key，已关闭此项。'
        : '密钥只保存在当前浏览器本地存储中。',
  };
}

function mergeProfiles(profiles) {
  const saved = Array.isArray(profiles) ? profiles : [];
  return DEFAULT_PROFILES.map((profile) => ({ ...profile, ...(saved.find((item) => item.id === profile.id) || {}) }));
}

function createDefaultPromptVersion(type, patch = {}) {
  return {
    id: 'default',
    name: type === 'generate' ? '默认标注提示词' : '默认质检提示词',
    content: DEFAULT_PROMPTS[type] || '',
    locked: true,
    source: 'bundled',
    ...patch,
  };
}

function normalizePromptVersions(type, versions, legacyPrompt) {
  const normalizedVersions = Array.isArray(versions)
    ? versions
        .filter((version) => version && typeof version === 'object')
        .map((version) => ({
          id: String(version.id || `local-${Date.now()}`),
          name: String(version.name || PROMPT_KIND_LABELS[type] || '提示词版本'),
          content: String(version.content || ''),
          locked: Boolean(version.locked),
          source: version.source || 'local',
          commitSha: version.commitSha || null,
          committedAt: version.committedAt || null,
          fetchedAt: version.fetchedAt || null,
          createdAt: version.createdAt || null,
          updatedAt: version.updatedAt || null,
        }))
        .filter((version) => version.id && version.content.trim())
    : [];

  const defaultIndex = normalizedVersions.findIndex((version) => version.id === 'default');
  const savedDefault = defaultIndex >= 0 ? normalizedVersions[defaultIndex] : null;
  const defaultVersion =
    savedDefault?.source === 'github'
      ? { ...createDefaultPromptVersion(type), ...savedDefault, id: 'default', locked: true }
      : createDefaultPromptVersion(type, savedDefault ? { ...savedDefault, content: DEFAULT_PROMPTS[type] || '', locked: true, source: savedDefault.source || 'bundled' } : {});

  const rest = normalizedVersions.filter((version) => version.id !== 'default');
  const legacy = String(legacyPrompt || '').trim();
  const legacyPromptToSkip = type === 'generate' ? LEGACY_GENERATE_PROMPT : LEGACY_PRECHECK_PROMPT;
  const hasLegacyCustom =
    legacy &&
    legacy !== DEFAULT_PROMPTS[type] &&
    legacy !== legacyPromptToSkip &&
    !rest.some((version) => version.content === legacy);
  if (hasLegacyCustom) {
    rest.push({
      id: `local-migrated-${type}`,
      name: '本地旧版提示词',
      content: legacy,
      locked: false,
      source: 'local',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  return [defaultVersion, ...rest];
}

function getPromptVersion(settings, type, versionId) {
  const versions = settings?.promptVersions?.[type] || [];
  return versions.find((version) => version.id === versionId) || versions.find((version) => version.id === 'default') || createDefaultPromptVersion(type);
}

function getActivePromptVersion(settings, type) {
  const versionId = settings?.activePromptVersionIds?.[type] || 'default';
  return getPromptVersion(settings, type, versionId);
}

function getActivePromptContent(settings, type) {
  return getActivePromptVersion(settings, type)?.content || DEFAULT_PROMPTS[type] || '';
}

function normalizeAiSettings(settings) {
  const saved = settings && typeof settings === 'object' ? settings : {};
  const savedPrompts = saved.prompts || {};
  const precheckVersions = normalizePromptVersions('precheck', saved.promptVersions?.precheck, savedPrompts.precheck);
  const generateVersions = normalizePromptVersions('generate', saved.promptVersions?.generate, savedPrompts.generate);
  const activePromptVersionIds = {
    precheck: saved.activePromptVersionIds?.precheck || 'default',
    generate: saved.activePromptVersionIds?.generate || 'default',
  };

  if (!precheckVersions.some((version) => version.id === activePromptVersionIds.precheck)) {
    activePromptVersionIds.precheck = 'default';
  }
  if (!generateVersions.some((version) => version.id === activePromptVersionIds.generate)) {
    activePromptVersionIds.generate = 'default';
  }

  const normalized = {
    ...saved,
    activeProfileId: saved.activeProfileId || DEFAULT_ACTIVE_PROFILE_ID,
    profiles: mergeProfiles(saved.profiles),
    github: {
      ...DEFAULT_GITHUB_CONFIG,
      ...(saved.github || {}),
    },
    promptVersions: {
      precheck: precheckVersions,
      generate: generateVersions,
    },
    activePromptVersionIds,
  };

  normalized.prompts = {
    precheck: getActivePromptContent(normalized, 'precheck'),
    generate: getActivePromptContent(normalized, 'generate'),
  };

  return normalized;
}

export function getCurrentAiPromptTemplate(type) {
  return getActivePromptContent(loadAiSettings(), type === 'generate' ? 'generate' : 'precheck');
}

export function fillAiPromptTemplate(template, context) {
  return fillTemplate(template, context);
}

function loadAiSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || 'null');
    if (!saved) throw new Error('empty');
    return normalizeAiSettings(saved);
  } catch (error) {
    return normalizeAiSettings({});
  }
}

function saveAiSettings(settings, options = {}) {
  const normalized = normalizeAiSettings(settings);
  const persistLocal = options.persistLocal ?? !preferRemoteSettings;
  if (persistLocal) {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(normalized));
  } else {
    localStorage.removeItem(AI_SETTINGS_KEY);
  }
  window.dispatchEvent(new CustomEvent(AI_SETTINGS_CHANGED_EVENT, { detail: normalized }));
  return normalized;
}

async function loadRemoteAiSettings() {
  const response = await fetch('/api/ai/settings');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  preferRemoteSettings = true;
  return normalizeAiSettings(await response.json());
}

async function persistRemoteAiSettings(settings) {
  const response = await fetch('/api/ai/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizeAiSettings(settings)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return normalizeAiSettings(await response.json());
}

async function syncRemoteDefaultPrompts() {
  const response = await fetch('/api/ai/sync-prompts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return {
    ...payload,
    settings: normalizeAiSettings(payload.settings || payload),
  };
}

function fillTemplate(template, context) {
  return String(template || '').replace(/&\{([^}]+)\}/g, (_, key) => String(context?.[key] ?? ''));
}

function renderAiInlineMarkdown(text) {
  const parts = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    } else {
      parts.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function renderAiMarkdownBlocks(value) {
  const lines = String(value || '').split(/\r?\n/);
  const blocks = [];
  let unorderedItems = [];
  let orderedItems = [];
  let codeFence = null;
  let codeLines = [];

  function flushUnorderedList() {
    if (!unorderedItems.length) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {unorderedItems.map((item, index) => (
          <li key={`${index}-${item}`}>{renderAiInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
    unorderedItems = [];
  }

  function flushOrderedList() {
    if (!orderedItems.length) return;
    blocks.push(
      <ol key={`ol-${blocks.length}`}>
        {orderedItems.map((item, index) => (
          <li key={`${index}-${item}`}>{renderAiInlineMarkdown(item)}</li>
        ))}
      </ol>,
    );
    orderedItems = [];
  }

  function flushLists() {
    flushUnorderedList();
    flushOrderedList();
  }

  function flushCode() {
    if (!codeFence) return;
    blocks.push(
      <pre className="markdown-code-block" key={`code-${blocks.length}`}>
        <code>{codeLines.join('\n')}</code>
      </pre>,
    );
    codeFence = null;
    codeLines = [];
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const fence = trimmed.match(/^(`{3,}|~{3,})/);

    if (codeFence) {
      if (fence && fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length) {
        flushCode();
      } else {
        codeLines.push(line);
      }
      return;
    }

    if (fence) {
      flushLists();
      codeFence = fence[1];
      codeLines = [];
      return;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)、]\s+(.+)$/);

    if (!trimmed) {
      flushLists();
      blocks.push(<div className="markdown-spacer" key={`blank-${index}`} />);
      return;
    }

    if (heading) {
      flushLists();
      const level = Math.min(heading[1].length + 2, 6);
      const HeadingTag = `h${level}`;
      blocks.push(<HeadingTag key={`heading-${index}`}>{renderAiInlineMarkdown(heading[2])}</HeadingTag>);
      return;
    }

    if (unordered) {
      flushOrderedList();
      unorderedItems.push(unordered[1]);
      return;
    }

    if (ordered) {
      flushUnorderedList();
      orderedItems.push(ordered[1]);
      return;
    }

    flushLists();
    blocks.push(<p key={`p-${index}`}>{renderAiInlineMarkdown(trimmed)}</p>);
  });

  flushCode();
  flushLists();
  return blocks.length ? blocks : [<p key="empty">暂无预览内容</p>];
}

function buildPlaceholderEntries(context) {
  if (Array.isArray(context?.__placeholderEntries) && context.__placeholderEntries.length) {
    return context.__placeholderEntries.map((entry) => ({
      key: entry.key,
      label: entry.label || entry.key,
      token: `&{${entry.key}}`,
      column: entry.column,
    }));
  }

  return Object.keys(context || {})
    .filter((key) => key && !key.startsWith('__') && typeof context[key] !== 'function')
    .map((key) => ({ key, label: key, token: `&{${key}}` }));
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function resolveOpenAiChatUrl(baseUrl) {
  const url = normalizeBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`;
  if (/\/(compatible-mode|paas)$/i.test(url)) return `${url}/v1/chat/completions`;
  if (/\/responses$/i.test(url)) return `${url.replace(/\/responses$/i, '')}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

function resolveOpenAiResponsesUrl(baseUrl) {
  const url = normalizeBaseUrl(baseUrl);
  if (/\/responses$/i.test(url)) return url;
  if (/\/chat\/completions$/i.test(url)) return `${url.replace(/\/chat\/completions$/i, '')}/responses`;
  if (/\/v1$/i.test(url)) return `${url}/responses`;
  return `${url}/v1/responses`;
}

function resolveOpenAiModelUrls(baseUrl) {
  const url = normalizeBaseUrl(baseUrl);
  if (/\/models$/i.test(url)) return [url];

  if (/\/chat\/completions$/i.test(url)) {
    const root = url.replace(/\/chat\/completions$/i, '');
    return [`${root}/v1/models`, `${root}/models`];
  }

  if (/\/responses$/i.test(url)) {
    const root = url.replace(/\/responses$/i, '');
    return [`${root}/models`, `${root.replace(/\/v1$/i, '')}/v1/models`];
  }

  if (/\/v1$/i.test(url)) return [`${url}/models`];
  if (/\/(compatible-mode|paas)$/i.test(url)) return [`${url}/v1/models`];
  return [`${url}/v1/models`, `${url}/models`];
}

async function getFirstJson(urls, headers = {}) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await getJson(url, headers);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('request failed');
}

function authHeaders(profile) {
  if (!profile.apiKey) return {};
  if (profile.mode === 'anthropic') return { 'x-api-key': profile.apiKey };
  return { Authorization: `Bearer ${profile.apiKey}` };
}

function extractTextFromResponse(mode, payload) {
  if (mode === 'openai-responses') {
    if (payload.output_text) return payload.output_text;
    return (payload.output || [])
      .flatMap((item) => item.content || [])
      .map((item) => item.text || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (mode === 'openai-chat') {
    return payload.choices?.[0]?.message?.content || '';
  }

  if (mode === 'anthropic') {
    return (payload.content || []).map((item) => item.text || '').join('\n').trim();
  }

  if (mode === 'gemini') {
    return (payload.candidates?.[0]?.content?.parts || []).map((item) => item.text || '').join('\n').trim();
  }

  if (mode === 'ollama') {
    return payload.message?.content || payload.response || '';
  }

  return '';
}

function stripReasoningText(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/^<think>[\s\S]*?(?=(?:^|\n)\s*[-*]?\s*(?:第\s*\d+\s*条\s*rubrics?\s*->|合格\b))/im, '')
    .replace(/^\s*(?:思考过程|推理过程|analysis|reasoning)\s*[:：][\s\S]*?(?=(?:^|\n)\s*[-*]?\s*(?:第\s*\d+\s*条\s*rubrics?\s*->|合格\b))/im, '')
    .trim();
}

function normalizePrecheckOutput(value) {
  const cleaned = stripReasoningText(value)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim())
    .trim();

  if (!cleaned) return '';
  if (/^[-*\s]*合格[。.!！\s]*$/i.test(cleaned)) return '合格';

  const lines = cleaned
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?=第\s*\d+\s*条\s*rubrics?\s*->)/i))
    .map((line) => line.trim().replace(/^[-*]\s*/, '').replace(/^[\d一二三四五六七八九十]+\s*[.、)]\s*/, ''))
    .filter(Boolean);

  const validLines = [];
  lines.forEach((line) => {
    const match = line.match(/^第\s*(\d+)\s*条\s*rubrics?\s*->\s*(.+)$/i);
    if (!match) return;
    const reason = match[2]
      .replace(/<\/?think>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!reason) return;
    validLines.push(`- 第${Number(match[1])}条rubrics -> ${reason}`);
  });

  if (validLines.length) return validLines.join('\n');
  if (/合格/.test(cleaned) && !/第\s*\d+\s*条\s*rubrics?/i.test(cleaned)) return '合格';
  return '';
}

function normalizeGenerateOutput(value) {
  return stripReasoningText(value);
}

function normalizeAiOutput(type, value) {
  if (type === 'precheck') return normalizePrecheckOutput(value);
  if (type === 'generate') return normalizeGenerateOutput(value);
  return stripReasoningText(value);
}

function addOutputGuard(type, promptText) {
  if (type !== 'precheck') return promptText;
  return [
    promptText,
    '',
    '## 输出格式硬性规则',
    '你必须只输出下面两种格式之一，不允许输出任何解释、分析、思考过程、Markdown 标题、代码块或 <think> 标签：',
    '1. 如果没有问题，只输出：合格',
    '2. 如果有问题，只输出 Markdown 无序列表，每行严格使用：- 第n条rubrics -> 问题描述',
    '错误示例：<think>...</think>、I am reviewing...、**Identifying issue**、总结段落。',
  ].join('\n');
}

async function postJson(url, headers, body) {
  return requestProxy({
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
  });
}

async function getJson(url, headers = {}) {
  return requestProxy({ url, method: 'GET', headers });
}

async function requestProxy({ url, method, headers = {}, body = null }) {
  const response = await fetch('/api/ai/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method, headers, body }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || text || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

function extractModelsFromPayload(mode, payload) {
  if (mode === 'ollama') {
    return (payload.models || []).map((model) => model.name).filter(Boolean);
  }

  if (mode === 'gemini') {
    return (payload.models || [])
      .map((model) => String(model.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  }

  return (payload.data || [])
    .map((model) => model.id || model.name)
    .filter(Boolean);
}

async function fetchModelList(profile) {
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  if (!baseUrl) throw new Error('请先配置 Base URL');
  if (profile.mode !== 'ollama' && !profile.apiKey) throw new Error('请先配置 API Key');

  if (profile.mode === 'ollama') {
    return extractModelsFromPayload(profile.mode, await getJson(`${baseUrl}/api/tags`));
  }

  if (profile.mode === 'gemini') {
    const keyParam = profile.apiKey ? `?key=${encodeURIComponent(profile.apiKey)}` : '';
    return extractModelsFromPayload(profile.mode, await getJson(`${baseUrl}/models${keyParam}`));
  }

  if (profile.mode === 'anthropic') {
    return extractModelsFromPayload(
      profile.mode,
      await getJson(`${baseUrl}/models`, {
        ...authHeaders(profile),
        'anthropic-version': '2023-06-01',
      }),
    );
  }

  return extractModelsFromPayload(
    profile.mode,
    await getFirstJson(resolveOpenAiModelUrls(baseUrl), authHeaders(profile)),
  );
}

async function requestAi(profile, promptText, modeName) {
  const baseUrl = normalizeBaseUrl(profile.baseUrl);
  const maxTokens = Number(profile.maxTokens) || 1800;
  const temperature = Number(profile.temperature) || 0.2;
  const capabilities = getProfileCapabilities(profile);
  const system = modeName === 'generate'
    ? '你是专业的 Rubrics 标注助手。'
    : '你是专业的 Rubrics 质检助手。';

  if (!baseUrl) throw new Error('请先配置 Base URL');
  if (profile.mode !== 'ollama' && !profile.apiKey) throw new Error('请先配置 API Key');
  if (!profile.model) throw new Error('请先配置模型名称');

  if (profile.mode === 'openai-responses') {
    const payload = await postJson(
      resolveOpenAiResponsesUrl(baseUrl),
      authHeaders(profile),
      {
        model: profile.model,
        ...(capabilities.supportsTemperature ? { temperature } : {}),
        ...(capabilities.supportsMaxTokens ? { max_output_tokens: maxTokens } : {}),
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: promptText }] },
        ],
      },
    );
    return extractTextFromResponse(profile.mode, payload);
  }

  if (profile.mode === 'openai-chat') {
    const payload = await postJson(
      resolveOpenAiChatUrl(baseUrl),
      authHeaders(profile),
      {
        model: profile.model,
        ...(capabilities.supportsTemperature ? { temperature } : {}),
        ...(capabilities.supportsMaxTokens ? { max_tokens: maxTokens } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: promptText },
        ],
      },
    );
    return extractTextFromResponse(profile.mode, payload);
  }

  if (profile.mode === 'anthropic') {
    const payload = await postJson(
      `${baseUrl}/messages`,
      {
        ...authHeaders(profile),
        'anthropic-version': '2023-06-01',
      },
      {
        model: profile.model,
        system,
        ...(capabilities.supportsTemperature ? { temperature } : {}),
        ...(capabilities.supportsMaxTokens ? { max_tokens: maxTokens } : {}),
        messages: [{ role: 'user', content: promptText }],
      },
    );
    return extractTextFromResponse(profile.mode, payload);
  }

  if (profile.mode === 'gemini') {
    const keyParam = profile.apiKey ? `?key=${encodeURIComponent(profile.apiKey)}` : '';
    const payload = await postJson(
      `${baseUrl}/models/${encodeURIComponent(profile.model)}:generateContent${keyParam}`,
      {},
      {
        contents: [{ role: 'user', parts: [{ text: `${system}\n\n${promptText}` }] }],
        generationConfig: {
          ...(capabilities.supportsTemperature ? { temperature } : {}),
          ...(capabilities.supportsMaxTokens ? { maxOutputTokens: maxTokens } : {}),
        },
      },
    );
    return extractTextFromResponse(profile.mode, payload);
  }

  if (profile.mode === 'ollama') {
    const payload = await postJson(
      `${baseUrl}/api/chat`,
      {},
      {
        model: profile.model,
        stream: false,
        options: {
          ...(capabilities.supportsTemperature ? { temperature } : {}),
          ...(capabilities.supportsMaxTokens ? { num_predict: maxTokens } : {}),
        },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: promptText },
        ],
      },
    );
    return extractTextFromResponse(profile.mode, payload);
  }

  throw new Error('不支持的接口模式');
}

function AiLineIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none">
        <path d="m12.594 23.258l-.012.002l-.071.035l-.02.004l-.014-.004l-.071-.036q-.016-.004-.024.006l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.016-.018m.264-.113l-.014.002l-.184.093l-.01.01l-.003.011l.018.43l.005.012l.008.008l.201.092q.019.005.029-.008l.004-.014l-.034-.614q-.005-.019-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.003-.011l.018-.43l-.003-.012l-.01-.01z" />
        <path fill="currentColor" d="M9.107 5.448c.598-1.75 3.016-1.803 3.725-.159l.06.16l.807 2.36a4 4 0 0 0 2.276 2.411l.217.081l2.36.806c1.75.598 1.803 3.016.16 3.725l-.16.06l-2.36.807a4 4 0 0 0-2.412 2.276l-.081.216l-.806 2.361c-.598 1.75-3.016 1.803-3.724.16l-.062-.16l-.806-2.36a4 4 0 0 0-2.276-2.412l-.216-.081l-2.36-.806c-1.751-.598-1.804-3.016-.16-3.724l.16-.062l2.36-.806A4 4 0 0 0 8.22 8.025l.081-.216zM11 6.094l-.806 2.36a6 6 0 0 1-3.49 3.649l-.25.091l-2.36.806l2.36.806a6 6 0 0 1 3.649 3.49l.091.25l.806 2.36l.806-2.36a6 6 0 0 1 3.49-3.649l.25-.09l2.36-.807l-2.36-.806a6 6 0 0 1-3.649-3.49l-.09-.25zM19 2a1 1 0 0 1 .898.56l.048.117l.35 1.026l1.027.35a1 1 0 0 1 .118 1.845l-.118.048l-1.026.35l-.35 1.027a1 1 0 0 1-1.845.117l-.048-.117l-.35-1.026l-1.027-.35a1 1 0 0 1-.118-1.845l.118-.048l1.026-.35l.35-1.027A1 1 0 0 1 19 2" />
      </g>
    </svg>
  );
}

export function AiAssistField({
  type,
  title,
  value,
  onChange,
  context,
  placeholder,
  manualPlaceholder,
  disabled = false,
  aiDisabled = false,
  onStatus,
  promptTemplate,
}) {
  const [settings, setSettings] = useState(loadAiSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPopoverStyle, setManualPopoverStyle] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const fieldRef = useRef(null);
  const skipPersistRef = useRef(true);

  const activeProfile = useMemo(
    () => {
      const profiles = settings.profiles?.length ? settings.profiles : DEFAULT_PROFILES;
      return profiles.find((profile) => profile.id === settings.activeProfileId) || profiles[0];
    },
    [settings],
  );

  useEffect(() => {
    let cancelled = false;
    loadRemoteAiSettings()
      .then((remoteSettings) => {
        if (cancelled) return;
        skipPersistRef.current = true;
        setSettings(remoteSettings);
        saveAiSettings(remoteSettings, { persistLocal: false });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    const normalized = saveAiSettings(settings);
    persistRemoteAiSettings(normalized).catch(() => {});
  }, [settings]);

  useEffect(() => {
    const target = fieldRef.current?.closest('.rubric-column')?.querySelector('.rubric-list-shell, .rubric-list');
    if (!target) return undefined;

    if (!running) {
      target.classList.remove('ai-thinking-target');
      gsap.killTweensOf(target);
      gsap.set(target, { clearProps: '--ai-border-angle,--ai-border-glow,--ai-border-opacity,--ai-spark-x' });
      return undefined;
    }

    target.classList.add('ai-thinking-target');
    gsap.set(target, {
      '--ai-border-angle': '0deg',
      '--ai-border-glow': 0.65,
      '--ai-border-opacity': 0.9,
      '--ai-spark-x': '0%',
    });

    const spin = gsap.to(target, {
      '--ai-border-angle': '360deg',
      duration: 1.45,
      ease: 'none',
      repeat: -1,
    });
    const pulse = gsap.to(target, {
      '--ai-border-glow': 1,
      '--ai-border-opacity': 1,
      duration: 0.55,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
    });
    const spark = gsap.to(target, {
      '--ai-spark-x': '100%',
      duration: 1.2,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
    });

    return () => {
      spin.kill();
      pulse.kill();
      spark.kill();
      target.classList.remove('ai-thinking-target');
      gsap.set(target, { clearProps: '--ai-border-angle,--ai-border-glow,--ai-border-opacity,--ai-spark-x' });
    };
  }, [running]);

  useEffect(() => {
    if (settingsOpen) setMenuOpen(false);
  }, [settingsOpen]);

  function getManualPopoverStyle() {
    const rect = fieldRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const width = Math.min(Math.max(520, rect.width), Math.max(280, viewportWidth - 24));
    const left = Math.min(Math.max(12, rect.right - width), viewportWidth - width - 12);
    const top = Math.min(rect.bottom + 6, Math.max(12, viewportHeight - 220));
    return { left, top, width };
  }

  useLayoutEffect(() => {
    if (!manualOpen) {
      setManualPopoverStyle(null);
      return undefined;
    }

    function updateManualPopoverPosition() {
      const nextStyle = getManualPopoverStyle();
      if (nextStyle) setManualPopoverStyle(nextStyle);
    }

    updateManualPopoverPosition();
    window.addEventListener('resize', updateManualPopoverPosition);
    window.addEventListener('scroll', updateManualPopoverPosition, true);
    return () => {
      window.removeEventListener('resize', updateManualPopoverPosition);
      window.removeEventListener('scroll', updateManualPopoverPosition, true);
    };
  }, [manualOpen]);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function closeOnOutsidePointer(event) {
      if (fieldRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    }

    function closeOnFocus(event) {
      if (fieldRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('focusin', closeOnFocus, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('focusin', closeOnFocus, true);
    };
  }, [menuOpen]);

  function updateSettings(nextSettings) {
    setSettings(normalizeAiSettings(nextSettings));
  }

  function selectProfile(profileId) {
    setSettings((previous) => ({ ...previous, activeProfileId: profileId }));
    setMenuOpen(false);
  }

  async function runAi() {
    if (disabled || aiDisabled || running) return;
    const template = getActivePromptContent(settings, type) || settings.prompts[type] || DEFAULT_PROMPTS[type];
    const promptText = addOutputGuard(type, fillTemplate(template, context));
    if (!promptText.trim()) {
      onStatus?.('没有可发送给 AI 的内容。');
      return;
    }

    setRunning(true);
    onStatus?.('AI 正在处理...');
    try {
      const result = normalizeAiOutput(type, await requestAi(activeProfile, promptText, type)).trim();
      if (!result) throw new Error('模型没有返回内容');
      onChange(result);
      onStatus?.('AI 结果已填入输入框。');
    } catch (error) {
      onStatus?.(`AI 请求失败：${String(error.message || error)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="stacked-label ai-assist-field" ref={fieldRef}>
      <div className="ai-field-head">
        <div className="ai-action-group">
          <button className="ai-main-button" type="button" onClick={runAi} disabled={disabled || aiDisabled || running}>
            <AiLineIcon size={16} />
            {running ? 'AI处理中' : title}
          </button>
          <div className="ai-menu-wrap">
            <button
              className="ai-menu-button"
              type="button"
              title="选择模型"
              onClick={() => {
                setMenuOpen((open) => !open);
                setManualOpen(false);
              }}
            >
              <ChevronDown size={16} />
            </button>
          </div>
        </div>
        <button
          className="ai-plus-button"
          type="button"
          title="手动输入"
          onClick={() => {
            const nextOpen = !manualOpen;
            setManualPopoverStyle(nextOpen ? getManualPopoverStyle() : null);
            setManualOpen(nextOpen);
            setMenuOpen(false);
          }}
        >
          <Plus size={17} />
        </button>
      </div>

      {menuOpen && (
        <div className="ai-model-menu">
          <div className="ai-model-menu-head">
            <strong>选择模型</strong>
            <button
              className="icon-button"
              type="button"
              title="AI设置"
              onClick={() => {
                setMenuOpen(false);
                setSettingsOpen(true);
              }}
            >
              <Settings size={15} />
            </button>
          </div>
          {(settings.profiles?.length ? settings.profiles : DEFAULT_PROFILES).length ? (
            (settings.profiles?.length ? settings.profiles : DEFAULT_PROFILES).map((profile) => (
              <button
                key={profile.id}
                className={profile.id === activeProfile.id ? 'active' : ''}
                type="button"
                onClick={() => selectProfile(profile.id)}
              >
                <span>{profile.name}</span>
                <small>{profile.model || MODE_LABELS[profile.mode]}</small>
              </button>
            ))
          ) : (
            <div className="ai-model-empty">暂无模型，请点击右上角设置。</div>
          )}
        </div>
      )}

      {manualOpen && (
        <div className="ai-manual-popover" style={manualPopoverStyle || undefined}>
          <div className="ai-manual-head">
            <strong>手动输入</strong>
            <button className="icon-button" type="button" title="关闭" onClick={() => setManualOpen(false)}>
              <X size={15} />
            </button>
          </div>
          <textarea
            className="ai-manual-textarea"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={manualPlaceholder || placeholder}
            spellCheck="false"
          />
        </div>
      )}

      {settingsOpen && (
        <AiSettingsPanel
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          activeType={type}
          context={context}
          promptTemplate={promptTemplate}
        />
      )}
    </div>
  );
}

function AiSettingsPanel({ settings, onChange, onClose, activeType, context, promptTemplate }) {
  const [section, setSection] = useState('api');
  const [draft, setDraft] = useState(settings);
  const [previewMode, setPreviewMode] = useState('markdown');
  const [modelOptions, setModelOptions] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelListMessage, setModelListMessage] = useState('');
  const [syncingPrompts, setSyncingPrompts] = useState(false);
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const promptTextareaRef = useRef(null);
  const versionMenuRef = useRef(null);
  const activeProfile = draft.profiles.find((profile) => profile.id === draft.activeProfileId) || draft.profiles[0];
  const promptKey = activeType === 'generate' ? 'generate' : 'precheck';
  const promptTitle = promptKey === 'generate' ? 'AI预生成Rubrics提示词' : 'AI预检Rubrics提示词';
  const placeholderEntries = useMemo(() => buildPlaceholderEntries(context), [context]);
  const promptVersions = draft.promptVersions?.[promptKey] || [];
  const currentPromptVersion = getActivePromptVersion(draft, promptKey);
  const currentPromptText = currentPromptVersion?.content || '';
  const currentPromptPreview = fillTemplate(currentPromptText, context);
  const activeProfileCapabilities = getProfileCapabilities(activeProfile);

  useEffect(() => {
    setModelOptions([]);
    setModelListMessage('');
  }, [draft.activeProfileId, activeProfile.mode, activeProfile.baseUrl, activeProfile.apiKey]);

  useEffect(() => {
    if (!versionMenuOpen) return undefined;

    function closeOnOutsidePointer(event) {
      if (versionMenuRef.current?.contains(event.target)) return;
      setVersionMenuOpen(false);
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [versionMenuOpen]);

  function updateActiveProfile(patch) {
    setDraft((previous) => ({
      ...previous,
      profiles: previous.profiles.map((profile) => (profile.id === previous.activeProfileId ? { ...profile, ...patch } : profile)),
    }));
  }

  async function loadModels() {
    setLoadingModels(true);
    setModelListMessage('');
    try {
      const models = await fetchModelList(activeProfile);
      const uniqueModels = [...new Set(models)].sort((left, right) => left.localeCompare(right));
      setModelOptions(uniqueModels);
      if (uniqueModels.length) {
        const nextModel = uniqueModels.includes(activeProfile.model) ? activeProfile.model : uniqueModels[0];
        updateActiveProfile({ model: nextModel });
        setModelListMessage(
          nextModel === activeProfile.model
            ? `已获取 ${uniqueModels.length} 个模型`
            : `已获取 ${uniqueModels.length} 个模型，已切换到 ${nextModel}`,
        );
      } else {
        setModelListMessage('接口没有返回可用模型，请手动填写模型名称');
      }
    } catch (error) {
      setModelOptions([]);
      setModelListMessage(`获取失败：${String(error.message || error)}`);
    } finally {
      setLoadingModels(false);
    }
  }

  function selectPromptVersion(versionId) {
    setDraft((previous) =>
      normalizeAiSettings({
        ...previous,
        activePromptVersionIds: {
          ...previous.activePromptVersionIds,
          [promptKey]: versionId,
        },
      }),
    );
  }

  function updateCurrentPrompt(value) {
    if (currentPromptVersion?.locked) return;
    setDraft((previous) =>
      normalizeAiSettings({
        ...previous,
        promptVersions: {
          ...previous.promptVersions,
          [promptKey]: (previous.promptVersions?.[promptKey] || []).map((version) =>
            version.id === currentPromptVersion.id
              ? { ...version, content: value, updatedAt: Date.now() }
              : version,
          ),
        },
      }),
    );
  }

  function copyVersionName(sourceName) {
    const baseName = String(sourceName || PROMPT_KIND_LABELS[promptKey] || '提示词版本')
      .replace(/\s+副本\d+$/, '')
      .trim();
    const existingNames = new Set(promptVersions.map((version) => version.name));
    let copyIndex = 1;
    while (existingNames.has(`${baseName} 副本${copyIndex}`)) copyIndex += 1;
    return `${baseName} 副本${copyIndex}`;
  }

  function blankVersionName() {
    const existingNames = new Set(promptVersions.map((version) => version.name));
    let copyIndex = 1;
    while (existingNames.has(`空白版本 ${copyIndex}`)) copyIndex += 1;
    return `空白版本 ${copyIndex}`;
  }

  function createPromptVersion({ sourceVersion = currentPromptVersion, blank = false } = {}) {
    const id = `local-${promptKey}-${Date.now()}`;
    const nextVersion = {
      id,
      name: blank ? blankVersionName() : copyVersionName(sourceVersion?.name),
      content: blank ? '' : (sourceVersion?.content || currentPromptText || ''),
      locked: false,
      source: 'local',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setDraft((previous) =>
      normalizeAiSettings({
        ...previous,
        promptVersions: {
          ...previous.promptVersions,
          [promptKey]: [...(previous.promptVersions?.[promptKey] || []), nextVersion],
        },
        activePromptVersionIds: {
          ...previous.activePromptVersionIds,
          [promptKey]: id,
        },
      }),
    );
  }

  function renameCurrentPromptVersion(name) {
    if (currentPromptVersion?.locked) return;
    setDraft((previous) =>
      normalizeAiSettings({
        ...previous,
        promptVersions: {
          ...previous.promptVersions,
          [promptKey]: (previous.promptVersions?.[promptKey] || []).map((version) =>
            version.id === currentPromptVersion.id
              ? { ...version, name, updatedAt: Date.now() }
              : version,
          ),
        },
      }),
    );
  }

  function deletePromptVersion(versionId) {
    const targetVersion = promptVersions.find((version) => version.id === versionId);
    if (!targetVersion || targetVersion.locked) return;
    setDraft((previous) =>
      normalizeAiSettings({
        ...previous,
        promptVersions: {
          ...previous.promptVersions,
          [promptKey]: (previous.promptVersions?.[promptKey] || []).filter((version) => version.id !== versionId),
        },
        activePromptVersionIds: {
          ...previous.activePromptVersionIds,
          [promptKey]: previous.activePromptVersionIds?.[promptKey] === versionId ? 'default' : previous.activePromptVersionIds?.[promptKey],
        },
      }),
    );
  }

  function deleteCurrentPromptVersion() {
    deletePromptVersion(currentPromptVersion?.id);
  }

  function save() {
    onChange(normalizeAiSettings(draft));
    onClose();
  }

  function resetPrompts() {
    setDraft((previous) =>
      normalizeAiSettings({
        ...previous,
        activePromptVersionIds: {
          ...previous.activePromptVersionIds,
          [promptKey]: 'default',
        },
      }),
    );
  }

  async function refreshDefaultPrompts() {
    setSyncingPrompts(true);
    try {
      const payload = await syncRemoteDefaultPrompts();
      setDraft(payload.settings);
      saveAiSettings(payload.settings);
      const results = payload.results || [];
      const updatedCount = results.filter((item) => item.updated).length;
      const errorCount = results.filter((item) => item.error).length;
      const message = errorCount ? `已更新 ${updatedCount} 个默认提示词，${errorCount} 个文件同步失败。` : `已更新 ${updatedCount} 个默认提示词。`;
      window.dispatchEvent(new CustomEvent(AI_NOTIFICATION_EVENT, { detail: { type: errorCount ? 'warning' : 'success', message } }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent(AI_NOTIFICATION_EVENT, { detail: { type: 'error', message: `同步失败：${String(error.message || error)}` } }));
    } finally {
      setSyncingPrompts(false);
    }
  }

  function insertPlaceholder(key) {
    const token = `&{${key}}`;
    const textarea = promptTextareaRef.current;
    const current = currentPromptText || '';
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
    updateCurrentPrompt(next);
    window.requestAnimationFrame(() => {
      const target = promptTextareaRef.current;
      if (!target) return;
      const position = start + token.length;
      target.focus();
      target.setSelectionRange(position, position);
    });
  }

  return (
    <div className="modal-backdrop">
      <section className="ai-settings-panel" aria-label="AI功能设置">
        <header className="template-modal-head">
          <div>
            <h2>AI功能设置</h2>
            <p>配置 API、模型和提示词，结果会写回当前输入框</p>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="ai-settings-body">
          <nav className="ai-settings-nav">
            <button className={section === 'api' ? 'active' : ''} type="button" onClick={() => setSection('api')}>
              API设置
            </button>
            <button className={section === 'prompt' ? 'active' : ''} type="button" onClick={() => setSection('prompt')}>
              提示词设置
            </button>
          </nav>

          <div className="ai-settings-content">
            {section === 'api' ? (
              <div className="ai-settings-form">
                <div className="ai-settings-intro">
                  <strong>模型连接配置</strong>
                  <p>选择接口模式后填写对应的 Base URL、API Key 和模型名称。Ollama 本地模式通常不需要 API Key。</p>
                </div>
                <label>
                  <FieldTitle required>当前模型配置</FieldTitle>
                  <select value={draft.activeProfileId} onChange={(event) => setDraft((previous) => ({ ...previous, activeProfileId: event.target.value }))}>
                    {draft.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                  <small>选择要编辑和调用的模型预设。</small>
                </label>
                <label>
                  <FieldTitle required>接口模式</FieldTitle>
                  <select value={activeProfile.mode} onChange={(event) => updateActiveProfile({ mode: event.target.value })}>
                    {Object.entries(MODE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <small>OpenAI Responses 适合官方新版接口；OpenAI兼容 Chat 适合多数中转或兼容服务。</small>
                </label>
                <label>
                  <FieldTitle required>显示名称</FieldTitle>
                  <input value={activeProfile.name} onChange={(event) => updateActiveProfile({ name: event.target.value })} />
                  <small>显示在模型下拉菜单里的名称。</small>
                </label>
                <label>
                  <FieldTitle required={activeProfileCapabilities.requiresBaseUrl}>Base URL</FieldTitle>
                  <input value={activeProfile.baseUrl} onChange={(event) => updateActiveProfile({ baseUrl: event.target.value })} />
                  <small>例如 https://api.openai.com/v1 或 http://localhost:11434。</small>
                </label>
                <label className={!activeProfileCapabilities.supportsApiKey ? 'field-disabled' : ''}>
                  <FieldTitle
                    required={activeProfileCapabilities.requiresApiKey}
                    optional={!activeProfileCapabilities.requiresApiKey && activeProfileCapabilities.supportsApiKey}
                    unsupported={!activeProfileCapabilities.supportsApiKey}
                  >
                    API Key
                  </FieldTitle>
                  <input
                    type="password"
                    value={activeProfile.apiKey}
                    onChange={(event) => updateActiveProfile({ apiKey: event.target.value })}
                    placeholder={activeProfileCapabilities.supportsApiKey ? '填写服务商 API Key' : '当前接口模式不使用 API Key'}
                    disabled={!activeProfileCapabilities.supportsApiKey}
                  />
                  <small>{activeProfileCapabilities.apiKeyHint}</small>
                </label>
                <label>
                  <FieldTitle required={activeProfileCapabilities.requiresModel}>模型名称</FieldTitle>
                  <div className="ai-model-input-row">
                    {modelOptions.length ? (
                      <select value={activeProfile.model} onChange={(event) => updateActiveProfile({ model: event.target.value })}>
                        {modelOptions.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input value={activeProfile.model} onChange={(event) => updateActiveProfile({ model: event.target.value })} />
                    )}
                    <button className="ghost-button" type="button" onClick={loadModels} disabled={loadingModels}>
                      {loadingModels ? '获取中' : '获取模型'}
                    </button>
                  </div>
                  <small>填写服务商要求的模型 ID，例如 gpt-4.1-mini、claude-3-5-sonnet-latest。</small>
                  {modelListMessage && <em>{modelListMessage}</em>}
                </label>
                <label className={!activeProfileCapabilities.supportsTemperature ? 'field-disabled' : ''}>
                  <FieldTitle unsupported={!activeProfileCapabilities.supportsTemperature}>温度</FieldTitle>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={activeProfile.temperature}
                    onChange={(event) => updateActiveProfile({ temperature: event.target.value })}
                    disabled={!activeProfileCapabilities.supportsTemperature}
                  />
                  <small>{activeProfileCapabilities.temperatureHint}</small>
                </label>
                <label className={!activeProfileCapabilities.supportsMaxTokens ? 'field-disabled' : ''}>
                  <FieldTitle unsupported={!activeProfileCapabilities.supportsMaxTokens}>最大输出 Token</FieldTitle>
                  <input
                    type="number"
                    min="256"
                    step="128"
                    value={activeProfile.maxTokens}
                    onChange={(event) => updateActiveProfile({ maxTokens: event.target.value })}
                    disabled={!activeProfileCapabilities.supportsMaxTokens}
                  />
                  <small>控制模型最多返回多少内容，rubrics 场景建议 1200 到 3000。</small>
                </label>
              </div>
            ) : (
              <div className="ai-prompt-settings with-preview">
                <div className="ai-prompt-toolbar">
                  <strong>{promptTemplate?.title || promptTitle}</strong>
                  <div className="ai-prompt-version-tools">
                    <select value={currentPromptVersion.id} onChange={(event) => selectPromptVersion(event.target.value)}>
                      {promptVersions.map((version) => (
                        <option key={version.id} value={version.id}>
                          {version.name}{version.locked ? '（默认）' : ''}
                        </option>
                      ))}
                    </select>
                    <button className="ghost-button" type="button" onClick={() => createPromptVersion(true)}>
                      复制为新版本
                    </button>
                    <button className="ghost-button" type="button" onClick={() => createPromptVersion(false)}>
                      新建空白版本
                    </button>
                    <button className="ghost-button danger" type="button" onClick={deleteCurrentPromptVersion} disabled={currentPromptVersion.locked}>
                      删除版本
                    </button>
                    <button className="ghost-button" type="button" onClick={refreshDefaultPrompts} disabled={syncingPrompts}>
                      {syncingPrompts ? '更新中...' : '更新默认版本'}
                    </button>
                  </div>
                  <div className="ai-placeholder-buttons" aria-label="快捷插入占位符">
                    {placeholderEntries.length ? (
                      placeholderEntries.map((entry) => (
                        <button
                          key={`${entry.column || ''}-${entry.key}`}
                          type="button"
                          title={`${entry.column ? `第${entry.column}列：` : ''}插入 ${entry.token}`}
                          onClick={() => insertPlaceholder(entry.key)}
                        >
                          {entry.label}
                        </button>
                      ))
                    ) : (
                      <span>解析原始数据后显示可用占位符</span>
                    )}
                  </div>
                </div>
                <div className="ai-prompt-version-control-row" ref={versionMenuRef}>
                  <div className="ai-prompt-version-combo">
                    <input
                      value={currentPromptVersion.name || ''}
                      onChange={(event) => renameCurrentPromptVersion(event.target.value)}
                      disabled={currentPromptVersion.locked}
                      title={currentPromptVersion.locked ? '默认版本不可修改，请复制为副本后编辑' : '修改当前提示词版本名称'}
                    />
                    <button
                      type="button"
                      title="选择提示词版本"
                      onClick={() => setVersionMenuOpen((open) => !open)}
                    >
                      <ChevronDown size={16} />
                    </button>
                    {versionMenuOpen && (
                      <div className="ai-prompt-version-menu">
                        {promptVersions.map((version) => (
                          <div
                            className={`ai-prompt-version-menu-item ${version.id === currentPromptVersion.id ? 'active' : ''}`}
                            key={version.id}
                          >
                            <button
                              className="ai-prompt-version-select"
                              type="button"
                              onClick={() => {
                                selectPromptVersion(version.id);
                                setVersionMenuOpen(false);
                              }}
                            >
                              <span>{version.name}{version.locked ? '（默认）' : ''}</span>
                              <small>
                                {version.locked ? '默认版本' : '自定义版本'}
                                {version.committedAt ? ` · ${version.committedAt}` : ''}
                              </small>
                            </button>
                            <button
                              className="icon-button"
                              type="button"
                              title="复制为副本"
                              onClick={(event) => {
                                event.stopPropagation();
                                createPromptVersion({ sourceVersion: version });
                                setVersionMenuOpen(false);
                              }}
                            >
                              <Copy size={14} />
                            </button>
                            <button
                              className="icon-button danger"
                              type="button"
                              title={version.locked ? '默认版本不可删除' : '删除版本'}
                              disabled={version.locked}
                              onClick={(event) => {
                                event.stopPropagation();
                                deletePromptVersion(version.id);
                                setVersionMenuOpen(false);
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                        <div className="ai-prompt-version-menu-footer">
                          <button
                            type="button"
                            onClick={() => {
                              createPromptVersion({ blank: true });
                              setVersionMenuOpen(false);
                            }}
                          >
                            <Plus size={15} />
                            新建空白版本
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    className="ghost-button ai-version-refresh-button"
                    type="button"
                    onClick={refreshDefaultPrompts}
                    disabled={syncingPrompts}
                  >
                    <RefreshCw size={15} />
                    {syncingPrompts ? '更新中...' : '更新默认版本'}
                  </button>
                  <small className="ai-prompt-version-hint">
                    {currentPromptVersion.locked ? '默认版本不可修改；如需编辑，请在下拉菜单复制为副本。' : '当前自定义版本会保存到本地数据库。'}
                    {currentPromptVersion.committedAt ? ` GitHub 提交时间：${currentPromptVersion.committedAt}` : ''}
                  </small>
                </div>
                <div className="ai-prompt-version-row">
                  <label>
                    <span>版本名称</span>
                    <input
                      value={currentPromptVersion.name || ''}
                      onChange={(event) => renameCurrentPromptVersion(event.target.value)}
                      disabled={currentPromptVersion.locked}
                    />
                  </label>
                  <small>
                    {currentPromptVersion.locked ? '默认版本不可修改；如需编辑，请复制为新版本。' : '当前版本会保存到本地数据库。'}
                    {currentPromptVersion.committedAt ? ` GitHub 提交时间：${currentPromptVersion.committedAt}` : ''}
                  </small>
                </div>
                <div className="ai-prompt-workspace">
                  <label className="ai-prompt-editor">
                    <span>原始模板</span>
                    <textarea
                      ref={promptTextareaRef}
                      value={currentPromptText}
                      onChange={(event) => updateCurrentPrompt(event.target.value)}
                      disabled={currentPromptVersion.locked}
                    />
                  </label>
                  {true && (
                    <section className="ai-prompt-preview">
                      <div className="ai-prompt-pane-title">
                        <strong>Markdown预览</strong>
                        <div className="mini-segmented">
                          <button
                            type="button"
                            className={previewMode === 'markdown' ? 'active' : ''}
                            onClick={() => setPreviewMode('markdown')}
                          >
                            Markdown
                          </button>
                          <button
                            type="button"
                            className={previewMode === 'raw' ? 'active' : ''}
                            onClick={() => setPreviewMode('raw')}
                          >
                            原始
                          </button>
                        </div>
                      </div>
                      <div className="ai-prompt-preview-body">
                        {previewMode === 'markdown' ? (
                          <div className="ai-prompt-rendered-markdown">{renderAiMarkdownBlocks(currentPromptPreview)}</div>
                        ) : (
                          <pre>{currentPromptPreview || ' '}</pre>
                        )}
                      </div>
                    </section>
                  )}
                </div>
                <p>点击上方按钮可插入占位符，发送 AI 请求时会用当前解析出的原始数据列自动替换。</p>
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={resetPrompts}>
            恢复默认提示词
          </button>
          <button className="ghost-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="button" onClick={save}>
            保存设置
          </button>
        </div>
      </section>
    </div>
  );
}
