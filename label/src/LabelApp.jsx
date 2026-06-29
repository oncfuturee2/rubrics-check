import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FileText,
  Link as LinkIcon,
  ListChecks,
  Maximize2,
  Minimize2,
  Move,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { EMPTY_PARSED_ZERO_NOTE_MESSAGE, parseRemarkIssues } from '../../src/rawRemarkParser.js';
import { AI_NOTIFICATION_EVENT, AiAssistField } from '../../src/aiAssist.jsx';
import { EMPTY_RAW_RECORD, buildAiPlaceholderContext, buildRawRecordTextWithCell, parseRawRecord } from '../../src/rawRecordParser.js';
import { usePersistentElementHeights } from '../../src/uiPreferences.js';

const STORAGE_KEY = 'rubrics-label-workbench.v1';
const PROMPT_PANEL_STATE_VERSION = 1;
const INITIAL_PROMPT_PANEL = {
  x: 12,
  y: 132,
  width: 460,
  height: 420,
  minimized: false,
  promptMode: 'markdown',
};

const EMPTY_DATA = { ...EMPTY_RAW_RECORD };

function trimCell(value) {
  return String(value ?? '').replace(/\u00A0/g, ' ').trim();
}

function stripCodeFence(value) {
  return String(value || '')
    .replace(/^`{3,4}\s*/g, '')
    .replace(/\s*`{3,4}$/g, '')
    .trim();
}

function parseDelimitedRows(rawText, delimiter) {
  const text = String(rawText || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      row.push(trimCell(cell));
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(trimCell(cell));
      rows.push(normalizeDelimitedRow(row, delimiter));
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(trimCell(cell));
  rows.push(normalizeDelimitedRow(row, delimiter));

  return rows
    .map((cells) => cells.map(trimCell))
    .filter((cells) => cells.some((cellValue) => cellValue !== ''));
}

function normalizeDelimitedRow(row, delimiter) {
  if (delimiter !== '|') return row;
  const next = [...row];
  if (next[0] === '') next.shift();
  if (next[next.length - 1] === '') next.pop();
  return next;
}

function looksLikeHeader(row) {
  const normalized = row.map((cell) => cell.trim().toLowerCase());
  return normalized.includes('prompt') && normalized.includes('repo');
}

function pickDataRow(rows) {
  const nonEmpty = rows.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (nonEmpty.length >= 2 && looksLikeHeader(nonEmpty[0])) return nonEmpty[1];
  return nonEmpty[0] || [];
}

function hasRubricNumberSpacingIssue(rubricsText) {
  return /^\s*\d+\s*[.、)](?=\S)/m.test(String(rubricsText || ''));
}

function getRubricNumberSpacingIssueNumbers(rubricsText) {
  return [...String(rubricsText || '').matchAll(/^\s*(\d+)\s*[.、)](?=\S)/gm)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function parseRawInput(rawText) {
  return parseRawRecord(rawText, { allowTwoColumns: true });
}

function parseRepoList(repoText) {
  const value = trimCell(repoText);
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch (error) {
    // Fall through to loose extraction.
  }

  const urlMatches = value.match(/https?:\/\/[^\s,"'\]\)]+/g);
  if (urlMatches) return urlMatches;

  return value
    .split(/[\n,，]+/)
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function parseRubricItems(rubricsText) {
  const text = String(rubricsText || '').trim();
  if (!text) return [];

  const numbered = [...text.matchAll(/^\s*(\d+)\s*[\.、\)]\s*(.+?)(?=\n\s*\d+\s*[\.、\)]\s*|$)/gms)]
    .map((match) => ({ id: crypto.randomUUID(), number: Number(match[1]), text: match[2].trim() }))
    .filter((item) => item.text);
  if (numbered.length) return numbered;

  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean)
    .map((line, index) => ({ id: crypto.randomUUID(), number: index + 1, text: line }));
}

function buildRubricsText(rubrics) {
  return rubrics.map((rubric, index) => `${index + 1}. ${rubric.text.trim()}`).join('\n');
}

function parseScoreMatrix(scoreText) {
  const original = stripCodeFence(scoreText);
  if (!original) return null;

  try {
    const parsed = JSON.parse(original);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((row) => (Array.isArray(row) ? row.map((value) => (value === 0 ? 0 : 1)) : []));
  } catch (error) {
    return null;
  }
}

function validateScoreMatrix(scoreText) {
  const original = stripCodeFence(scoreText);
  if (!original) {
    return { ok: false, matrix: null, errors: ['评分列为空，需要填写 0/1 二维数组。'] };
  }

  if (/[，；]/.test(original)) {
    return { ok: false, matrix: null, errors: ['评分列包含中文逗号或中文分号，二维数组必须使用英文逗号。'] };
  }

  let parsed;
  try {
    parsed = JSON.parse(original);
  } catch (error) {
    return { ok: false, matrix: null, errors: [`评分列不是合法 JSON 二维数组：${error.message}`] };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, matrix: parsed, errors: ['评分列顶层必须是数组，例如 [[1,0],[1,1]]。'] };
  }

  const errors = [];
  parsed.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      errors.push(`第 ${rowIndex + 1} 行评分不是数组。`);
      return;
    }
    row.forEach((value, colIndex) => {
      if (!(value === 0 || value === 1)) {
        errors.push(`第 ${rowIndex + 1} 行第 ${colIndex + 1} 列评分不是 0 或 1。`);
      }
    });
  });

  return { ok: errors.length === 0, matrix: parsed, errors };
}

function validateParsedInput(result) {
  if (!result) return { ok: false, errors: [], warnings: [] };
  if (!result.ok) return { ok: false, errors: result.errors || [], warnings: [] };

  const data = result.data || EMPTY_DATA;
  const errors = [];
  const warnings = [];
  const repos = parseRepoList(data.repo);

  if (!String(data.prompt || '').trim()) errors.push('prompt 列为空。');
  if (!repos.length) errors.push('repo 列未解析到链接。');

  const hasLabelPayload = Boolean(
    String(data.rubrics || '').trim() ||
    String(data.score || '').trim() ||
    String(data.note || '').trim(),
  );

  if (result.type === 'two' || !hasLabelPayload) {
    return { ok: errors.length === 0, errors, warnings };
  }

  const rubrics = parseRubricItems(data.rubrics || '');
  const score = validateScoreMatrix(data.score || '');
  const matrix = Array.isArray(score.matrix) ? score.matrix : null;

  if (!rubrics.length) errors.push('rubrics 列未解析到编号条目。');
  errors.push(...score.errors);

  if (matrix) {
    const rowLengths = matrix.map((row) => (Array.isArray(row) ? row.length : '非数组'));
    const uniqueLengths = [...new Set(rowLengths.map(String))];
    if (uniqueLengths.length > 1) errors.push(`评分矩阵各行长度不一致：${rowLengths.join('、')}。`);
    if (repos.length && matrix.length !== repos.length) {
      errors.push(`评分矩阵行数应等于 repo 数量 ${repos.length}，当前为 ${matrix.length}。`);
    }
    if (rubrics.length) {
      matrix.forEach((row, index) => {
        if (Array.isArray(row) && row.length !== rubrics.length) {
          errors.push(`第 ${index + 1} 行评分数量应等于 rubrics 条数 ${rubrics.length}，当前为 ${row.length}。`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function parseQcIssueMessage(rawMessage) {
  const raw = String(rawMessage || '').trim();
  let message = raw;
  const scoreMatch = message.match(/【分数应修改为([01])分】/);
  const targetScore = scoreMatch ? Number(scoreMatch[1]) : null;
  message = message.replace(/【分数应修改为[01]分】/g, '').trim();
  return { message, rawMessage: raw, targetScore };
}

function addQcIssue(issueMap, key, issue) {
  const existing = issueMap.get(key);
  if (!existing) {
    issueMap.set(key, issue);
    return;
  }

  issueMap.set(key, {
    message: [existing.message, issue.message].filter(Boolean).join('\n'),
    rawMessage: [existing.rawMessage, issue.rawMessage].filter(Boolean).join('\n'),
    targetScore: issue.targetScore ?? existing.targetScore,
  });
}

function parseQcComment(commentText) {
  const issueMap = new Map();
  const lines = String(commentText || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean);

  lines.forEach((line) => {
    const globalRubricMatch = line.match(/^第\s*(\d+)\s*(?:条|个)\s*rub(?:rics|tics)?\s*->\s*(.+)$/i);
    if (globalRubricMatch) {
      addQcIssue(issueMap, `rubric:${Number(globalRubricMatch[1]) - 1}`, parseQcIssueMessage(globalRubricMatch[2]));
      return;
    }

    const otherMatch = line.match(/^其他质检问题\s*->\s*(.+)$/);
    if (otherMatch) {
      addQcIssue(issueMap, 'other', parseQcIssueMessage(otherMatch[1]));
      return;
    }

    const pageMatch = line.match(/第\s*(\d+)\s*个页面/);
    if (!pageMatch) return;
    const pageIndex = Number(pageMatch[1]) - 1;

    const pageIssueMatch = line.match(/页面整体问题\s*->\s*(.+)$/);
    if (pageIssueMatch) {
      addQcIssue(issueMap, `page:${pageIndex}`, parseQcIssueMessage(pageIssueMatch[1]));
      return;
    }

    const matches = [...line.matchAll(/第\s*(\d+)\s*(?:条|个)\s*rub(?:rics|tics)?\s*->\s*([^；;]+)/gi)];
    matches.forEach((match) => {
      const rubricIndex = Number(match[1]) - 1;
      addQcIssue(issueMap, `${pageIndex}:${rubricIndex}`, parseQcIssueMessage(match[2]));
    });
  });

  return issueMap;
}

function buildMoveIndexMap(length, fromIndex, toIndex) {
  const order = Array.from({ length }, (_, index) => index);
  const [moved] = order.splice(fromIndex, 1);
  order.splice(toIndex, 0, moved);
  const indexMap = new Map();
  order.forEach((oldIndex, newIndex) => indexMap.set(oldIndex, newIndex));
  return indexMap;
}

function buildRemoveIndexMap(length, removedIndex) {
  const indexMap = new Map();
  Array.from({ length }, (_, index) => index).forEach((oldIndex) => {
    if (oldIndex === removedIndex) indexMap.set(oldIndex, null);
    else indexMap.set(oldIndex, oldIndex > removedIndex ? oldIndex - 1 : oldIndex);
  });
  return indexMap;
}

function reorderByIndexMap(items, indexMap) {
  const next = [];
  (items || []).forEach((item, oldIndex) => {
    const newIndex = indexMap.get(oldIndex);
    if (newIndex === null || newIndex === undefined) return;
    next[newIndex] = item;
  });
  return next.filter((item) => item !== undefined);
}

function rewriteRubricSegmentIndex(segment, indexMap) {
  const match = segment.match(/^(\s*)第\s*(\d+)\s*(条|个)\s*rub(?:rics|tics)?\s*->\s*(.+)$/i);
  if (!match) return segment;
  const newIndex = indexMap.get(Number(match[2]) - 1);
  if (newIndex === null || newIndex === undefined) return '';
  return `${match[1]}第${newIndex + 1}${match[3]}rubrics -> ${match[4].trim()}`;
}

function rewriteQcCommentRubricIndexes(commentText, indexMap) {
  return String(commentText || '')
    .split(/\r?\n/)
    .map((line) => {
      const bullet = line.match(/^(\s*[-*]\s*)/);
      const prefix = bullet ? bullet[1] : '';
      const body = line.trim().replace(/^[-*]\s*/, '');
      if (!body) return '';

      const global = rewriteRubricSegmentIndex(body, indexMap);
      if (!global) return '';
      if (global !== body) return `${prefix}${global}`;

      const pageMatch = body.match(/^(第\s*\d+\s*个页面\s*->\s*)(.+)$/);
      if (!pageMatch || !/rub(?:rics|tics)?/i.test(pageMatch[2])) return line;

      const segments = pageMatch[2]
        .split(/[；;]/)
        .map((segment) => rewriteRubricSegmentIndex(segment.trim(), indexMap))
        .filter(Boolean);
      if (!segments.length) return '';
      return `${prefix}${pageMatch[1]}${segments.join('；')}`;
    })
    .filter((line) => line.trim())
    .join('\n');
}

function remapQcStateKeys(state, indexMap) {
  const next = {};
  Object.entries(state || {}).forEach(([key, value]) => {
    const globalMatch = key.match(/^rubric:(\d+)$/);
    const pageMatch = key.match(/^(\d+):(\d+)$/);
    const match = globalMatch || pageMatch;
    if (!match) {
      next[key] = value;
      return;
    }

    const oldRubricIndex = Number(globalMatch ? match[1] : match[2]);
    const newRubricIndex = indexMap.get(oldRubricIndex);
    if (newRubricIndex === null || newRubricIndex === undefined) return;
    const nextKey = globalMatch ? `rubric:${newRubricIndex}` : `${match[1]}:${newRubricIndex}`;
    next[nextKey] = value;
  });
  return next;
}

function normalizeMatrix(repos, rubrics, matrix, defaultScore = 1) {
  return repos.map((_, repoIndex) =>
    rubrics.map((_, rubricIndex) => {
      const value = matrix?.[repoIndex]?.[rubricIndex];
      return value === 0 || value === 1 ? value : defaultScore;
    }),
  );
}

function normalizeNotes(repos, rubrics, previousNotes, remarkMap) {
  return repos.map((_, repoIndex) =>
    rubrics.map((_, rubricIndex) => {
      const previous = previousNotes?.[repoIndex]?.[rubricIndex];
      return previous ?? remarkMap.get(`${repoIndex}:${rubricIndex}`) ?? '';
    }),
  );
}

function buildNoteOutput(repos, rubrics, scores, notes) {
  const lines = [];

  repos.forEach((_, repoIndex) => {
    const items = [];
    rubrics.forEach((rubric, rubricIndex) => {
      if (scores?.[repoIndex]?.[rubricIndex] !== 0) return;
      const note = String(notes?.[repoIndex]?.[rubricIndex] || '').trim() || '未填写备注';
      items.push(`第${rubricIndex + 1}条rubrics->${note}`);
    });
    if (items.length) lines.push(`${lines.length + 1}.第${repoIndex + 1}个页面->${items.join('；')}`);
  });

  return lines.join('\n');
}

function findMissingZeroScoreNotes(repos, rubrics, scores, notes) {
  const missing = [];

  repos.forEach((_, repoIndex) => {
    rubrics.forEach((_, rubricIndex) => {
      if (scores?.[repoIndex]?.[rubricIndex] !== 0) return;
      if (String(notes?.[repoIndex]?.[rubricIndex] || '').trim()) return;
      missing.push({ repoIndex, rubricIndex });
    });
  });

  return missing;
}

function buildRawTextWithRubricsCell(parseResult, rubricsText) {
  return buildRawRecordTextWithCell(parseResult, parseResult?.rubricsColumnIndex ?? 3, rubricsText);
}

function decodeHtmlText(value) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value.trim();
}

function extractPageTitle(htmlText) {
  const match = String(htmlText || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return decodeHtmlText(match[1]).replace(/\s+/g, ' ').trim();
}

async function fetchPageTitle(url, signal) {
  try {
    const proxied = await fetch(`/api/page-title?url=${encodeURIComponent(url)}`, { signal });
    if (proxied.ok) {
      const data = await proxied.json();
      if (data.title) return data.title;
    }
  } catch (error) {
    // Fall back to direct browser fetch.
  }

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return extractPageTitle(await response.text());
}

function labelForRepo(url, index) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts.at(-2) || parts.at(-1) || parsed.hostname || `页面 ${index + 1}`;
  } catch (error) {
    return `页面 ${index + 1}`;
  }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function StatusBadge({ type = 'neutral', children }) {
  return <span className={`status-badge ${type}`}>{children}</span>;
}

function AutoGrowTextarea({ className = '', value, onChange, minHeight = 44, ...props }) {
  const textareaRef = useRef(null);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.max(minHeight, element.scrollHeight)}px`;
  }, [value, minHeight]);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      className={className}
      value={value}
      onChange={onChange}
    />
  );
}

function AnimatedNoteTextarea({ value, onChange, placeholder, hasMissingNote = false, flashToken = 0 }) {
  const textareaRef = useRef(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || !hasMissingNote || !flashToken) return undefined;

    gsap.killTweensOf(element);
    const animation = gsap.fromTo(
      element,
      { borderColor: '#dc2626', backgroundColor: '#fff1f2', boxShadow: '0 0 0 0 rgba(220, 38, 38, 0)' },
      {
        borderColor: '#ef4444',
        backgroundColor: '#ffe4e6',
        boxShadow: '0 0 0 7px rgba(220, 38, 38, 0.36)',
        duration: 0.15,
        repeat: 5,
        yoyo: true,
        ease: 'power1.inOut',
        clearProps: 'borderColor,backgroundColor,boxShadow',
      },
    );

    return () => animation.kill();
  }, [flashToken, hasMissingNote]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || hasMissingNote) return;
    gsap.killTweensOf(element);
    gsap.set(element, { clearProps: 'borderColor,backgroundColor,boxShadow' });
  }, [hasMissingNote]);

  return (
    <div className="issue-textarea-wrap">
      <textarea
        ref={textareaRef}
        className={hasMissingNote ? 'missing-note-input' : ''}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
    </div>
  );
}

function RubricsFormatModal({ value, onChange, onConfirm, onClose }) {
  const issueNumbers = getRubricNumberSpacingIssueNumbers(value);
  const issueText = issueNumbers.length
    ? `列表序号后面需要保留一个空格，第${issueNumbers.join('、')}条rubrics序号后没有空格。`
    : '列表序号后面需要保留一个空格。';

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="rubrics-format-modal"
        role="dialog"
        aria-modal="true"
        aria-label="rubrics格式修复"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="template-modal-head">
          <div>
            <h2>rubrics格式不正确</h2>
            <p>{issueText}</p>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="rubrics-format-body">
          <label className="stacked-label">
            原始 rubrics
            <textarea
              value={value}
              onChange={(event) => onChange(event.target.value)}
              spellCheck="false"
              placeholder="请修正 rubrics 列表序号后的空格"
            />
          </label>
        </div>

        <div className="modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="button" onClick={onConfirm}>
            确定并应用到原始输入框
          </button>
        </div>
      </section>
    </div>
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function renderInlineMarkdown(text) {
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

function renderMarkdownBlocks(value) {
  const lines = String(value || '未解析 prompt').split(/\r?\n/);
  const blocks = [];
  let listItems = [];

  function flushList() {
    if (!listItems.length) return;
    blocks.push(
      <ul key={`list-${blocks.length}`}>
        {listItems.map((item, index) => (
          <li key={`${index}-${item}`}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);

    if (!trimmed) {
      flushList();
      blocks.push(<div className="markdown-spacer" key={`blank-${index}`} />);
      return;
    }

    if (heading) {
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      const HeadingTag = `h${level}`;
      blocks.push(<HeadingTag key={`heading-${index}`}>{renderInlineMarkdown(heading[2])}</HeadingTag>);
      return;
    }

    if (bullet) {
      listItems.push(bullet[1]);
      return;
    }

    flushList();
    blocks.push(<p key={`p-${index}`}>{renderInlineMarkdown(trimmed)}</p>);
  });

  flushList();
  return blocks;
}

function PromptFloatingPanel({
  panel,
  prompt,
  onDragStart,
  onResizeStart,
  onToggleMinimize,
  onPromptModeChange,
}) {
  const panelStyle = panel.minimized
    ? { left: panel.x, top: panel.y }
    : { left: panel.x, top: panel.y, width: panel.width, height: panel.height };

  return (
    <aside className={`floating-panel prompt-floating-panel ${panel.minimized ? 'minimized' : ''}`} style={panelStyle}>
      <div className="floating-panel-head" onPointerDown={onDragStart} onDoubleClick={onToggleMinimize}>
        <span>
          <Move size={13} />
          <FileText size={14} />
          <strong>原始Prompt</strong>
        </span>
        {!panel.minimized && (
          <div className="floating-head-actions" onPointerDown={(event) => event.stopPropagation()}>
            <div className="mini-segmented">
              <button
                className={panel.promptMode === 'markdown' ? 'active' : ''}
                type="button"
                onClick={() => onPromptModeChange('markdown')}
              >
                Markdown
              </button>
              <button
                className={panel.promptMode === 'raw' ? 'active' : ''}
                type="button"
                onClick={() => onPromptModeChange('raw')}
              >
                原格式
              </button>
            </div>
          </div>
        )}
        <button
          className="icon-button"
          type="button"
          title={panel.minimized ? '展开 Prompt' : '最小化 Prompt'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onToggleMinimize}
        >
          {panel.minimized ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
        </button>
      </div>

      {!panel.minimized && (
        <>
          <div className="prompt-floating-body">
            <div className={`prompt-content ${panel.promptMode === 'markdown' ? 'markdown' : ''}`}>
              {panel.promptMode === 'markdown' ? renderMarkdownBlocks(prompt) : <pre>{prompt || '未解析 prompt'}</pre>}
            </div>
          </div>
          <div className="panel-resize-handle" onPointerDown={onResizeStart} />
        </>
      )}
    </aside>
  );
}

function SidePromptPanel({ panel, prompt, onPromptModeChange }) {
  return (
    <section className="side-context-stack label-side-context">
      <div className="side-context-card prompt-side-card" data-ui-height-key="prompt">
        <div className="pane-title pane-title-with-actions">
          <span>原始 Prompt</span>
          <div className="mini-segmented">
            <button
              className={panel.promptMode === 'markdown' ? 'active' : ''}
              type="button"
              onClick={() => onPromptModeChange('markdown')}
            >
              Markdown
            </button>
            <button
              className={panel.promptMode === 'raw' ? 'active' : ''}
              type="button"
              onClick={() => onPromptModeChange('raw')}
            >
              原格式
            </button>
          </div>
        </div>
        <div className={`prompt-content ${panel.promptMode === 'markdown' ? 'markdown' : ''}`}>
          {panel.promptMode === 'markdown' ? renderMarkdownBlocks(prompt) : <pre>{prompt || '未解析 prompt'}</pre>}
        </div>
      </div>
    </section>
  );
}

function OutputCard({ title, actions, className = '', heightKey, children }) {
  return (
    <section className={`side-context-card output-card ${className}`} data-ui-height-key={heightKey || undefined}>
      <div className="pane-title pane-title-with-actions">
        <span>{title}</span>
        {actions}
      </div>
      <div className="output-card-body">{children}</div>
    </section>
  );
}

function LabelApp() {
  const [rawText, setRawText] = useState('');
  const [data, setData] = useState(EMPTY_DATA);
  const [parseResult, setParseResult] = useState(null);
  const [rubrics, setRubrics] = useState([]);
  const [rubricsText, setRubricsText] = useState('');
  const [scores, setScores] = useState([]);
  const [notes, setNotes] = useState([]);
  const [qcComment, setQcComment] = useState('');
  const [resolvedQc, setResolvedQc] = useState({});
  const [selectedRepo, setSelectedRepo] = useState(0);
  const [frameKey, setFrameKey] = useState(0);
  const [isFrameFullscreen, setIsFrameFullscreen] = useState(false);
  const [repoTitles, setRepoTitles] = useState({});
  const [toast, setToast] = useState('');
  const [missingNoteKeys, setMissingNoteKeys] = useState({});
  const [missingNoteFlashToken, setMissingNoteFlashToken] = useState(0);
  const [scrollTarget, setScrollTarget] = useState(null);
  const [promptPanel, setPromptPanel] = useState(INITIAL_PROMPT_PANEL);
  const [promptPanelInteraction, setPromptPanelInteraction] = useState(null);
  const [rubricsFormatModal, setRubricsFormatModal] = useState(null);
  const rubricListRef = useRef(null);
  const noteOutputRef = useRef(null);
  const outputPanelRef = useRef(null);
  const rawParseTimerRef = useRef(null);

  const repos = useMemo(() => parseRepoList(data.repo), [data.repo]);
  const inputValidation = useMemo(() => validateParsedInput(parseResult), [parseResult]);
  const isRawInputValid = inputValidation.ok;
  const repoKey = useMemo(() => repos.join('\n'), [repos]);
  const currentRepoUrl = repos[selectedRepo] || '';
  usePersistentElementHeights(outputPanelRef, 'label', `${repoKey}:${selectedRepo}`);
  const qcIssueMap = useMemo(() => parseQcComment(qcComment), [qcComment]);
  const finalRubricsText = useMemo(() => buildRubricsText(rubrics), [rubrics]);
  const scoreOutput = useMemo(() => JSON.stringify(normalizeMatrix(repos, rubrics, scores)), [repos, rubrics, scores]);
  const noteOutput = useMemo(() => buildNoteOutput(repos, rubrics, scores, notes), [repos, rubrics, scores, notes]);
  const hasMissingNoteErrors = Object.keys(missingNoteKeys).length > 0;
  const currentPageIssue = qcIssueMap.get(`page:${selectedRepo}`);
  const otherQcIssue = qcIssueMap.get('other');
  const aiPlaceholderContext = useMemo(
    () => buildAiPlaceholderContext(data, { rubrics: rubricsText }),
    [data, rubricsText],
  );

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      setRawText(saved.rawText || '');
      setData({ ...EMPTY_DATA, ...(saved.data || {}) });
      setParseResult(saved.parseResult || null);
      setRubrics(saved.rubrics || []);
      setRubricsText(saved.rubricsText || buildRubricsText(saved.rubrics || []));
      setScores(saved.scores || []);
      setNotes(saved.notes || []);
      setQcComment(saved.qcComment || '');
      setResolvedQc(saved.resolvedQc || {});
      setSelectedRepo(saved.selectedRepo || 0);
      setRepoTitles(saved.repoTitles || {});
      if (saved.promptPanelVersion === PROMPT_PANEL_STATE_VERSION) {
        setPromptPanel({ ...INITIAL_PROMPT_PANEL, ...(saved.promptPanel || {}) });
      }
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        rawText,
        data,
        parseResult,
        rubrics,
        rubricsText,
        scores,
        notes,
        qcComment,
        resolvedQc,
        selectedRepo,
        repoTitles,
        promptPanel,
        promptPanelVersion: PROMPT_PANEL_STATE_VERSION,
      }),
    );
  }, [
    rawText,
    data,
    parseResult,
    rubrics,
    rubricsText,
    scores,
    notes,
    qcComment,
    resolvedQc,
    selectedRepo,
    repoTitles,
    promptPanel,
  ]);

  useEffect(() => {
    setScores((previous) => normalizeMatrix(repos, rubrics, previous));
    setNotes((previous) => normalizeNotes(repos, rubrics, previous, new Map()));
    if (selectedRepo >= repos.length) setSelectedRepo(0);
  }, [repos.length, rubrics.length]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    function handleAiNotification(event) {
      const message = event?.detail?.message;
      if (message) setToast(message);
    }
    window.addEventListener(AI_NOTIFICATION_EVENT, handleAiNotification);
    return () => window.removeEventListener(AI_NOTIFICATION_EVENT, handleAiNotification);
  }, []);

  useEffect(
    () => () => {
      if (rawParseTimerRef.current) window.clearTimeout(rawParseTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    setMissingNoteKeys((previous) => {
      const previousKeys = Object.keys(previous);
      if (!previousKeys.length) return previous;

      const currentMissing = new Set(findMissingZeroScoreNotes(repos, rubrics, scores, notes).map(({ repoIndex, rubricIndex }) => `${repoIndex}:${rubricIndex}`));
      const next = {};
      previousKeys.forEach((key) => {
        if (currentMissing.has(key)) next[key] = true;
      });

      const nextKeys = Object.keys(next);
      if (nextKeys.length === previousKeys.length && nextKeys.every((key) => previous[key])) return previous;
      return next;
    });
  }, [repos, rubrics, scores, notes]);

  useEffect(() => {
    if (!hasMissingNoteErrors) setScrollTarget(null);
  }, [hasMissingNoteErrors]);

  useEffect(() => {
    function keepPanelInViewport() {
      setPromptPanel((previous) => ({
        ...previous,
        x: clamp(previous.x, 6, Math.max(6, window.innerWidth - 72)),
        y: clamp(previous.y, 6, Math.max(6, window.innerHeight - 42)),
        width: clamp(previous.width, 320, Math.max(320, window.innerWidth - previous.x - 8)),
        height: clamp(previous.height, 220, Math.max(220, window.innerHeight - previous.y - 8)),
      }));
    }

    keepPanelInViewport();
    window.addEventListener('resize', keepPanelInViewport);
    return () => window.removeEventListener('resize', keepPanelInViewport);
  }, []);

  useEffect(() => {
    if (!promptPanelInteraction) return undefined;

    function handlePointerMove(event) {
      setPromptPanel((previous) => {
        if (promptPanelInteraction.type === 'move') {
          return {
            ...previous,
            x: clamp(promptPanelInteraction.originX + event.clientX - promptPanelInteraction.startX, 6, window.innerWidth - 72),
            y: clamp(promptPanelInteraction.originY + event.clientY - promptPanelInteraction.startY, 6, window.innerHeight - 42),
          };
        }

        return {
          ...previous,
          width: clamp(
            promptPanelInteraction.originWidth + event.clientX - promptPanelInteraction.startX,
            320,
            Math.max(320, window.innerWidth - previous.x - 8),
          ),
          height: clamp(
            promptPanelInteraction.originHeight + event.clientY - promptPanelInteraction.startY,
            220,
            Math.max(220, window.innerHeight - previous.y - 8),
          ),
        };
      });
    }

    function handlePointerUp() {
      setPromptPanelInteraction(null);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [promptPanelInteraction]);

  useEffect(() => {
    if (!repos.length) {
      setRepoTitles({});
      return undefined;
    }

    const controller = new AbortController();
    setRepoTitles((previous) => {
      const next = {};
      repos.forEach((url) => {
        if (previous[url]) next[url] = previous[url];
      });
      return next;
    });

    repos.forEach((url) => {
      fetchPageTitle(url, controller.signal)
        .then((title) => {
          if (title) setRepoTitles((previous) => ({ ...previous, [url]: title }));
        })
        .catch(() => {});
    });

    return () => controller.abort();
  }, [repoKey]);

  useEffect(() => {
    if (!rubricListRef.current) return undefined;
    const cards = gsap.utils.toArray(rubricListRef.current.querySelectorAll('.rubric-item'));
    if (!cards.length) return undefined;
    gsap.killTweensOf(cards);
    gsap.set(cards, { autoAlpha: 0, y: 14, scale: 0.985 });
    const animation = gsap.to(cards, {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: 0.32,
      stagger: 0.032,
      ease: 'power2.out',
      clearProps: 'transform,opacity,visibility',
    });
    return () => animation.kill();
  }, [selectedRepo, rubrics.length]);

  useEffect(() => {
    const element = noteOutputRef.current;
    if (!element || !missingNoteFlashToken || !hasMissingNoteErrors) return undefined;

    gsap.killTweensOf(element);
    const animation = gsap.fromTo(
      element,
      { borderColor: '#dc2626', backgroundColor: '#fff1f2', boxShadow: '0 0 0 0 rgba(220, 38, 38, 0)' },
      {
        borderColor: '#ef4444',
        backgroundColor: '#ffe4e6',
        boxShadow: '0 0 0 7px rgba(220, 38, 38, 0.32)',
        duration: 0.16,
        repeat: 5,
        yoyo: true,
        ease: 'power1.inOut',
        clearProps: 'borderColor,backgroundColor,boxShadow',
      },
    );

    return () => animation.kill();
  }, [missingNoteFlashToken, hasMissingNoteErrors]);

  useEffect(() => {
    if (hasMissingNoteErrors || !noteOutputRef.current) return;
    gsap.killTweensOf(noteOutputRef.current);
    gsap.set(noteOutputRef.current, { clearProps: 'borderColor,backgroundColor,boxShadow' });
  }, [hasMissingNoteErrors]);

  useEffect(() => {
    if (!scrollTarget || scrollTarget.repoIndex !== selectedRepo || !rubricListRef.current) return undefined;

    const timer = window.setTimeout(() => {
      const card = rubricListRef.current?.querySelector(`[data-rubric-index="${scrollTarget.rubricIndex}"]`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [scrollTarget, selectedRepo, missingNoteFlashToken]);

  function applyParsedData(result) {
    const nextRepos = parseRepoList(result.data.repo);
    const nextRubrics = parseRubricItems(result.data.rubrics || '');
    const nextMatrix = parseScoreMatrix(result.data.score || '');
    const remarkMap = parseRemarkIssues(result.data.note || '');

    setData({ ...EMPTY_DATA, ...(result.data || {}) });
    setRubrics(nextRubrics);
    setRubricsText(buildRubricsText(nextRubrics));
    setScores(normalizeMatrix(nextRepos, nextRubrics, nextMatrix));
    setNotes(normalizeNotes(nextRepos, nextRubrics, null, remarkMap));
    setQcComment(result.data.qcComment || '');
    setSelectedRepo(0);
    setFrameKey((value) => value + 1);
    setRepoTitles({});
  }

  function parseAndApply(text = rawText, { showToast = true } = {}) {
    if (rawParseTimerRef.current) window.clearTimeout(rawParseTimerRef.current);
    rawParseTimerRef.current = null;
    const result = parseRawInput(text);
    const validation = validateParsedInput(result);
    setParseResult(result);
    if (result.ok && validation.ok) {
      applyParsedData(result);
      if (hasRubricNumberSpacingIssue(result.data.rubrics)) {
        setRubricsFormatModal({ draft: result.data.rubrics });
      } else {
        setRubricsFormatModal(null);
      }
      if (showToast) setToast(`已解析 ${result.displayName || '原始'}数据`);
    } else {
      setRubricsFormatModal(null);
      if (showToast) setToast([...validation.errors, ...validation.warnings].join(' ') || result.errors.join(' '));
    }
  }

  function handleRawTextChange(value) {
    setRawText(value);
    if (rawParseTimerRef.current) window.clearTimeout(rawParseTimerRef.current);
    rawParseTimerRef.current = window.setTimeout(() => {
      parseAndApply(value, { showToast: false });
      rawParseTimerRef.current = null;
    }, 350);
  }

  async function pasteAndParse() {
    try {
      const text = await navigator.clipboard.readText();
      if (rawParseTimerRef.current) window.clearTimeout(rawParseTimerRef.current);
      rawParseTimerRef.current = null;
      setRawText(text);
      parseAndApply(text);
    } catch (error) {
      setToast('剪贴板读取失败，请手动粘贴。');
    }
  }

  function handleRubricsTextChange(value) {
    setRubricsText(value);
    const nextRubrics = parseRubricItems(value);
    setRubrics(nextRubrics);
    setScores((previous) => normalizeMatrix(repos, nextRubrics, previous));
    setNotes((previous) => normalizeNotes(repos, nextRubrics, previous, new Map()));
  }

  function updateRubricText(rubricIndex, text) {
    setRubrics((previous) => {
      const next = previous.map((rubric, index) => (index === rubricIndex ? { ...rubric, text } : rubric));
      setRubricsText(buildRubricsText(next));
      return next;
    });
  }

  function addRubric() {
    setRubrics((previous) => {
      const next = [...previous, { id: crypto.randomUUID(), number: previous.length + 1, text: '' }];
      setRubricsText(buildRubricsText(next));
      setScores((oldScores) => normalizeMatrix(repos, next, oldScores));
      setNotes((oldNotes) => normalizeNotes(repos, next, oldNotes, new Map()));
      return next;
    });
  }

  function applyRubricIndexMap(indexMap) {
    setQcComment((previous) => rewriteQcCommentRubricIndexes(previous, indexMap));
    setResolvedQc((previous) => remapQcStateKeys(previous, indexMap));
    setMissingNoteKeys((previous) => remapQcStateKeys(previous, indexMap));
    setScrollTarget(null);
  }

  function removeRubric(rubricIndex) {
    const indexMap = buildRemoveIndexMap(rubrics.length, rubricIndex);
    setRubrics((previous) => {
      const next = reorderByIndexMap(previous, indexMap);
      setRubricsText(buildRubricsText(next));
      setScores((oldScores) => oldScores.map((row) => reorderByIndexMap(row, indexMap)));
      setNotes((oldNotes) => oldNotes.map((row) => reorderByIndexMap(row, indexMap)));
      return next;
    });
    applyRubricIndexMap(indexMap);
  }

  function moveRubric(rubricIndex, direction) {
    const nextIndex = rubricIndex + direction;
    if (nextIndex < 0 || nextIndex >= rubrics.length) return;
    const indexMap = buildMoveIndexMap(rubrics.length, rubricIndex, nextIndex);
    setRubrics((previous) => {
      const next = reorderByIndexMap(previous, indexMap);
      setRubricsText(buildRubricsText(next));
      setScores((oldScores) => oldScores.map((row) => reorderByIndexMap(row, indexMap)));
      setNotes((oldNotes) => oldNotes.map((row) => reorderByIndexMap(row, indexMap)));
      return next;
    });
    applyRubricIndexMap(indexMap);
  }

  function clearMissingNoteKey(repoIndex, rubricIndex) {
    const key = `${repoIndex}:${rubricIndex}`;
    setMissingNoteKeys((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }

  function updateScore(repoIndex, rubricIndex, score) {
    setScores((previous) => {
      const next = normalizeMatrix(repos, rubrics, previous);
      next[repoIndex][rubricIndex] = score;
      return next;
    });
    if (score !== 0) clearMissingNoteKey(repoIndex, rubricIndex);
  }

  function updateNote(repoIndex, rubricIndex, note) {
    setNotes((previous) => {
      const next = normalizeNotes(repos, rubrics, previous, new Map());
      next[repoIndex][rubricIndex] = note;
      return next;
    });
    if (String(note || '').trim()) clearMissingNoteKey(repoIndex, rubricIndex);
  }

  function clearAll() {
    if (rawParseTimerRef.current) window.clearTimeout(rawParseTimerRef.current);
    rawParseTimerRef.current = null;
    setRawText('');
    setData(EMPTY_DATA);
    setParseResult(null);
    setRubrics([]);
    setRubricsText('');
    setScores([]);
    setNotes([]);
    setQcComment('');
    setResolvedQc({});
    setSelectedRepo(0);
    setRepoTitles({});
    setPromptPanelInteraction(null);
    setRubricsFormatModal(null);
    setToast('已清空');
  }

  function applyRubricsFormatFix() {
    const nextRawText = buildRawTextWithRubricsCell(parseResult, rubricsFormatModal?.draft || '');
    if (!nextRawText) {
      setRubricsFormatModal(null);
      setToast('无法回写 rubrics，请检查原始输入列数。');
      return;
    }

    setRubricsFormatModal(null);
    setRawText(nextRawText);
    parseAndApply(nextRawText);
  }

  function startPromptPanelDrag(event) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPromptPanelInteraction({
      type: 'move',
      startX: event.clientX,
      startY: event.clientY,
      originX: promptPanel.x,
      originY: promptPanel.y,
    });
    event.preventDefault();
  }

  function startPromptPanelResize(event) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPromptPanelInteraction({
      type: 'resize',
      startX: event.clientX,
      startY: event.clientY,
      originWidth: promptPanel.width,
      originHeight: promptPanel.height,
    });
    event.preventDefault();
  }

  function togglePromptPanel() {
    setPromptPanel((previous) => ({ ...previous, minimized: !previous.minimized }));
  }

  function setPromptPanelMode(promptMode) {
    setPromptPanel((previous) => ({ ...previous, promptMode }));
  }

  async function copyAndToast(text, message) {
    try {
      await copyText(text);
      setToast(message);
    } catch (error) {
      setToast('复制失败，请手动选中文本复制。');
    }
  }

  async function copyResultAndToast(text, message) {
    const missingNotes = findMissingZeroScoreNotes(repos, rubrics, scores, notes);
    if (missingNotes.length) {
      const firstMissing = missingNotes[0];
      const nextMissingNoteKeys = {};
      missingNotes.forEach(({ repoIndex, rubricIndex }) => {
        nextMissingNoteKeys[`${repoIndex}:${rubricIndex}`] = true;
      });
      const listed = missingNotes
        .slice(0, 5)
        .map(({ repoIndex, rubricIndex }) => `第${repoIndex + 1}个页面第${rubricIndex + 1}条rubric`)
        .join('、');
      const suffix = missingNotes.length > 5 ? `等${missingNotes.length}处` : '';
      setMissingNoteKeys(nextMissingNoteKeys);
      setMissingNoteFlashToken((value) => value + 1);
      setScrollTarget(firstMissing);
      setSelectedRepo(firstMissing.repoIndex);
      setToast(`${listed}${suffix}打了0分但没有填写备注，请补充后再复制。`);
      return;
    }

    setMissingNoteKeys({});
    setScrollTarget(null);
    await copyAndToast(text, message);
  }

  function captureIframeTitle(event) {
    if (!currentRepoUrl) return;
    try {
      const title = event.currentTarget.contentDocument?.title?.trim();
      if (title) setRepoTitles((previous) => ({ ...previous, [currentRepoUrl]: title }));
    } catch (error) {
      // Cross-origin iframe.
    }
  }

  function toggleResolvedQc(repoIndexOrKey, rubricIndex, checked) {
    const key = rubricIndex === null ? repoIndexOrKey : `${repoIndexOrKey}:${rubricIndex}`;
    setResolvedQc((previous) => ({ ...previous, [key]: checked }));
  }

  function getPendingQcCount(repoIndex) {
    let count = 0;
    const pageKey = `page:${repoIndex}`;
    if (qcIssueMap.has(pageKey) && !resolvedQc[pageKey]) count += 1;
    rubrics.forEach((_, rubricIndex) => {
      const key = `${repoIndex}:${rubricIndex}`;
      const globalKey = `rubric:${rubricIndex}`;
      if (qcIssueMap.has(key) && !resolvedQc[key]) count += 1;
      if (qcIssueMap.has(globalKey) && !resolvedQc[globalKey]) count += 1;
    });
    return count;
  }

  return (
    <div className={`app-shell label-app ${isRawInputValid ? '' : 'input-invalid'} ${promptPanelInteraction ? 'dragging-panel' : ''}`}>
      <main className="workbench-grid">
        <section className="left-workspace">
          <section className="input-panel">
            <div className="section-head input-toolbar">
              <div>
                <h1>Rubrics 标注工作台</h1>
                <div className="toolbar-subline">
                  <p>支持 prompt/repo 两列，也支持 6 列或完整 19 列数据继续修改</p>
                  <div className="parse-line inline">
                    {parseResult ? (
                      <StatusBadge type={inputValidation.ok ? 'success' : 'warning'}>
                        {parseResult.ok ? `已解析：${parseResult.displayName || '数据'}` : parseResult.errors.join(' ')}
                      </StatusBadge>
                    ) : (
                      <StatusBadge>等待解析</StatusBadge>
                    )}
                    {inputValidation.errors.map((error) => (
                      <StatusBadge type="danger" key={error}>
                        {error}
                      </StatusBadge>
                    ))}
                    {inputValidation.warnings.map((warning) => (
                      <StatusBadge type="warning" key={warning}>
                        {warning}
                      </StatusBadge>
                    ))}
                  </div>
                </div>
              </div>
              <div className="button-row">
                <button className="primary-button" type="button" onClick={() => parseAndApply()}>
                  <ListChecks size={16} />
                  解析
                </button>
                <button className="ghost-button" type="button" onClick={pasteAndParse}>
                  <ClipboardPaste size={16} />
                  粘贴
                </button>
                <button className="ghost-button danger" type="button" onClick={clearAll}>
                  <Trash2 size={16} />
                  清空
                </button>
              </div>
            </div>

            <textarea
              className="raw-input"
              value={rawText}
              onChange={(event) => handleRawTextChange(event.target.value)}
              placeholder="粘贴 prompt / repo 两列，或粘贴 6 列/19 列整行数据"
              spellCheck="false"
            />
          </section>

          <section className={`viewer-panel ${isFrameFullscreen ? 'frame-fullscreen' : ''}`}>
            <div className="repo-list">
              {repos.length ? (
                repos.map((repoUrl, index) => {
                  const zeroCount = scores[index]?.filter((score) => score === 0).length || 0;
                  const pendingQcCount = getPendingQcCount(index);
                  return (
                    <button
                      className={`repo-item ${selectedRepo === index ? 'active' : ''} ${pendingQcCount ? 'needs-repair' : ''}`}
                      type="button"
                      key={repoUrl}
                      onClick={() => setSelectedRepo(index)}
                    >
                      <span className="repo-index">{index + 1}</span>
                      <span className="repo-text">{repoTitles[repoUrl] || labelForRepo(repoUrl, index)}</span>
                      {pendingQcCount > 0 && <span className="repair-pill">{pendingQcCount}</span>}
                      {zeroCount > 0 && <span className="issue-pill">{zeroCount}</span>}
                    </button>
                  );
                })
              ) : (
                <div className="empty-state">解析后显示页面列表</div>
              )}
            </div>

            <div className="url-bar">
              <LinkIcon size={16} />
              <span>{currentRepoUrl || '未选择页面'}</span>
              {currentRepoUrl && (
                <a className="icon-button as-link" href={currentRepoUrl} target="_blank" rel="noreferrer" title="新窗口打开">
                  <ExternalLink size={16} />
                </a>
              )}
              <button className="icon-button" type="button" title="刷新预览" onClick={() => setFrameKey((key) => key + 1)} disabled={!currentRepoUrl}>
                <RefreshCw size={16} />
              </button>
              <button
                className="icon-button"
                type="button"
                title={isFrameFullscreen ? '复原网页窗口' : '全屏显示网页'}
                onClick={() => setIsFrameFullscreen((value) => !value)}
                disabled={!currentRepoUrl}
              >
                {isFrameFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </div>

            <div className="frame-shell">
              {currentRepoUrl ? (
                <iframe
                  key={`${currentRepoUrl}-${frameKey}`}
                  src={currentRepoUrl}
                  title={repoTitles[currentRepoUrl] || `第 ${selectedRepo + 1} 个页面`}
                  onLoad={captureIframeTitle}
                />
              ) : (
                <div className="empty-state large">等待选择待测链接</div>
              )}
            </div>
          </section>
        </section>

        <section className="review-panel label-panel">
          <div className="review-body">
            <div className="rubric-column">
              <div className="rubric-tool-strip">
                <strong>Rubrics列表</strong>
                <AiAssistField
                  type="generate"
                  title="AI预生成Rubrics"
                  value={rubricsText}
                  onChange={handleRubricsTextChange}
                  context={aiPlaceholderContext}
                  placeholder="在这里编写或粘贴标准 rubrics，下面卡片会同步更新"
                  manualPlaceholder="手动输入或粘贴 Rubrics"
                  disabled={!data.prompt?.trim()}
                  onStatus={setToast}
                />
              </div>
              {(currentPageIssue || otherQcIssue) && (
                <div className="qc-summary-list">
                  {currentPageIssue && (
                    <div className={`annotation-note qc-note ${resolvedQc[`page:${selectedRepo}`] ? 'resolved' : ''}`}>
                      <div className="qc-note-head">
                        <strong>页面整体问题</strong>
                        <label>
                          <input
                            type="checkbox"
                            checked={Boolean(resolvedQc[`page:${selectedRepo}`])}
                            onChange={(event) => toggleResolvedQc(`page:${selectedRepo}`, null, event.target.checked)}
                          />
                          已修改
                        </label>
                      </div>
                      <p>{currentPageIssue.rawMessage || currentPageIssue.message}</p>
                    </div>
                  )}
                  {otherQcIssue && (
                    <div className={`annotation-note qc-note ${resolvedQc.other ? 'resolved' : ''}`}>
                      <div className="qc-note-head">
                        <strong>其他质检问题</strong>
                        <label>
                          <input
                            type="checkbox"
                            checked={Boolean(resolvedQc.other)}
                            onChange={(event) => toggleResolvedQc('other', null, event.target.checked)}
                          />
                          已修改
                        </label>
                      </div>
                      <p>{otherQcIssue.rawMessage || otherQcIssue.message}</p>
                    </div>
                  )}
                </div>
              )}
              <div className="rubric-list-shell">
                <div className="rubric-list" ref={rubricListRef}>
                {rubrics.length ? (
                  rubrics.map((rubric, rubricIndex) => {
                    const score = scores[selectedRepo]?.[rubricIndex] ?? 1;
                    const note = notes[selectedRepo]?.[rubricIndex] || '';
                    const qcKey = `${selectedRepo}:${rubricIndex}`;
                    const rubricQcKey = `rubric:${rubricIndex}`;
                    const rubricQcIssue = qcIssueMap.get(rubricQcKey);
                    const scoreQcIssue = qcIssueMap.get(qcKey);
                    const qcIssues = [
                      { key: rubricQcKey, title: 'Rubrics质检评论', issue: rubricQcIssue },
                      { key: qcKey, title: '分数质检评论', issue: scoreQcIssue },
                    ].filter((item) => item.issue);
                    const hasMissingNote = score === 0 && !String(note).trim();

                    return (
                      <article
                        className={`rubric-item ${qcIssues.length ? 'mismatch' : ''}`}
                        data-rubric-index={rubricIndex}
                        key={`${rubric.id}-${selectedRepo}`}
                      >
                        <div className="rubric-head">
                          <strong>第 {rubricIndex + 1} 条Rubrics</strong>
                          <div className="rubric-actions">
                            <button
                              className="icon-button"
                              type="button"
                              title="上移 rubric"
                              onClick={() => moveRubric(rubricIndex, -1)}
                              disabled={rubricIndex === 0}
                            >
                              <ArrowUp size={15} />
                            </button>
                            <button
                              className="icon-button"
                              type="button"
                              title="下移 rubric"
                              onClick={() => moveRubric(rubricIndex, 1)}
                              disabled={rubricIndex === rubrics.length - 1}
                            >
                              <ArrowDown size={15} />
                            </button>
                            <button className="icon-button" type="button" title="删除 rubric" onClick={() => removeRubric(rubricIndex)}>
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>

                        <AutoGrowTextarea
                          className="rubric-edit"
                          value={rubric.text}
                          onChange={(event) => updateRubricText(rubricIndex, event.target.value)}
                          placeholder="填写 rubric 内容"
                          minHeight={44}
                        />

                        {rubricQcIssue && (
                          <div className={`annotation-note qc-note ${resolvedQc[rubricQcKey] ? 'resolved' : ''}`}>
                            <div className="qc-note-head">
                              <strong>Rubrics质检评论</strong>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={Boolean(resolvedQc[rubricQcKey])}
                                  onChange={(event) => toggleResolvedQc(rubricQcKey, null, event.target.checked)}
                                />
                                已修改
                              </label>
                            </div>
                            <p>{rubricQcIssue.rawMessage || rubricQcIssue.message || '需要修改该条 rubric'}</p>
                          </div>
                        )}

                        <div className="segmented">
                          <button className={score === 1 ? 'active pass' : ''} type="button" onClick={() => updateScore(selectedRepo, rubricIndex, 1)}>
                            <Check size={15} />
                            1分
                          </button>
                          <button className={score === 0 ? 'active fail' : ''} type="button" onClick={() => updateScore(selectedRepo, rubricIndex, 0)}>
                            <X size={15} />
                            0分
                          </button>
                        </div>

                        {score === 0 && (
                          <AnimatedNoteTextarea
                            value={note}
                            onChange={(event) => updateNote(selectedRepo, rubricIndex, event.target.value)}
                            placeholder={note ? '填写 0 分备注，此内容会进入备注输出' : EMPTY_PARSED_ZERO_NOTE_MESSAGE}
                            hasMissingNote={hasMissingNote}
                            flashToken={missingNoteFlashToken}
                          />
                        )}

                        {scoreQcIssue && (
                          <div className={`annotation-note qc-note ${resolvedQc[qcKey] ? 'resolved' : ''}`}>
                            <div className="qc-note-head">
                              <strong>分数质检评论</strong>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={Boolean(resolvedQc[qcKey])}
                                  onChange={(event) => toggleResolvedQc(qcKey, null, event.target.checked)}
                                />
                                已修改
                              </label>
                            </div>
                            <p>{scoreQcIssue.rawMessage || scoreQcIssue.message || '需要修改该条分数'}</p>
                          </div>
                        )}
                      </article>
                    );
                  })
                ) : (
                  <div className="empty-state large">在上方 rubrics 输入框编写条目，或点击下方添加</div>
                )}
                </div>
              </div>
              <div className="add-rubric-row">
                <button className="primary-button" type="button" onClick={addRubric}>
                  <Plus size={16} />
                  添加rubric
                </button>
              </div>
            </div>

            <section className="output-panel label-output-panel" ref={outputPanelRef}>
              <SidePromptPanel
                panel={promptPanel}
                prompt={data.prompt}
                onPromptModeChange={setPromptPanelMode}
              />
              <section className="flat-output-section label-result-card">
                <div className="output-grid label-output-grid">
                  <OutputCard
                    title="rubrics"
                    className="nested-output-card auto-textarea-card label-rubrics-output-card"
                    heightKey="rubrics"
                    actions={
                      <button className="ghost-button output-copy-button" type="button" onClick={() => copyAndToast(finalRubricsText, '已复制 rubrics')}>
                        <Copy size={14} />
                        复制rubrics
                      </button>
                    }
                  >
                    <textarea value={finalRubricsText} readOnly />
                  </OutputCard>
                  <OutputCard
                    title="评分"
                    className="nested-output-card auto-textarea-card label-score-output-card"
                    heightKey="score"
                    actions={
                      <button className="ghost-button output-copy-button" type="button" onClick={() => copyResultAndToast(scoreOutput, '已复制评分')}>
                        <Copy size={14} />
                        复制评分
                      </button>
                    }
                  >
                    <textarea value={scoreOutput} readOnly />
                  </OutputCard>
                  <OutputCard
                    title="备注"
                    className="nested-output-card output-comment-label"
                    heightKey="note"
                    actions={
                      <button className="ghost-button output-copy-button" type="button" onClick={() => copyResultAndToast(noteOutput, '已复制备注')}>
                        <Copy size={14} />
                        复制备注
                      </button>
                    }
                  >
                    <textarea
                      ref={noteOutputRef}
                      className={`output-textarea ${hasMissingNoteErrors ? 'missing-note-output' : ''}`}
                      value={noteOutput}
                      readOnly
                    />
                  </OutputCard>
                </div>
              </section>
            </section>
          </div>
        </section>
      </main>

      {rubricsFormatModal && (
        <RubricsFormatModal
          value={rubricsFormatModal.draft}
          onChange={(draft) => setRubricsFormatModal((previous) => ({ ...(previous || {}), draft }))}
          onClose={() => setRubricsFormatModal(null)}
          onConfirm={applyRubricsFormatFix}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default LabelApp;
