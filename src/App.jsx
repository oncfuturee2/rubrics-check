import { useEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import {
  AlertTriangle,
  Check,
  Clipboard,
  ClipboardPaste,
  Copy,
  ExternalLink,
  FileText,
  Link as LinkIcon,
  ListChecks,
  Maximize2,
  Minimize2,
  Move,
  RefreshCw,
  RotateCcw,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import defaultRubricsReviewTemplate from '../prompt.md?raw';
import { EMPTY_PARSED_ZERO_NOTE_MESSAGE, extractPageRemarkText, formatRemarkTree, parseRemarkIssues } from './rawRemarkParser.js';

const STORAGE_KEY = 'rubrics-qc-workbench.v1';
const FLOATING_PANEL_STATE_VERSION = 3;
const REPO_TITLE_STATE_VERSION = 2;
const INITIAL_FLOATING_PANEL = {
  x: 12,
  y: 132,
  width: 760,
  height: 420,
  split: 0.58,
  minimized: false,
  promptMode: 'markdown',
  noteMode: 'current',
  beautifyNote: true,
};

const EMPTY_DATA = {
  prompt: '',
  repo: '',
  taskType: '',
  rubrics: '',
  score: '',
  note: '',
};

const DEFAULT_RUBRICS_REVIEW_TEMPLATE = defaultRubricsReviewTemplate.trim();

const RUBRICS_RULES = `# Rubrics标注
根据prompt写成高质量的Rubrics，明确整理并描述各项得分点，形成清晰的评分依据。更准确地识别前端生成结果是否满足需求，以及满足到了什么程度。关键就是输出的rubrics能够将核心内容“东西做没做成，关键点做没做对”量化成可以打分的评判依据，将笼统的prompt描述变成严格定义且没有歧义的打分单位，rubrics里的每一点就是对prompt里的要求的完成情况的给分点。

优先保留下面这些特征：
- 对任务完成度或结果可用性有实质影响
- 能通过代码、行为、输出或静态检查较稳定判断
- 一条 rubric 只检查一件事
- 不依赖主观解释，prompt里面描述的是什么就一定要保持描述一致，不要凭空捏造，泛化，猜想并延伸原本的意思。这点尤为重要，要严格执行。
- 相同意思只保留一条

不要写：
- 美观、友好、流畅、现代感
- 结构清晰、模块化设计、代码风格规范
- 难以稳定判断的弱要求

数量建议：
- 4 到 10条，优先保留最重要的显式要求

## 特殊规则：UI 使用中文评分项
- 若整套 rubric 条目总数≤9 条，将 UI 中文项单独列为一条评分标准
- 无法单独拆分时：
  1. 原有 rubric 中包含 UI / 界面设计相关条目，则归入该条目下评分
  2. 无界面相关条目，则合并至风格类 rubric 内评判

## 示例
prompt:
创建一个直观的酒店数据驾驶舱单页应用，用于展示酒店的关键运营指标，
比如实时呈现本月的入住率、客房收入和平均房价；
同时用图表清晰展示近期的客户来源分布，所有数据应都能支持快速按日期筛选并突出显示关键趋势

rubrics:
1. 创建一个可正确加载的单页面数据看板应用
2. 数据看板中包含酒店的关键运营指标，比如呈现本月的入住率、客房收入和平均房价
3. 选用合适的图表展示客群分布
4. 看板中所有数据支持按日期筛选且联动高亮展示`;

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
  return (
    normalized.includes('prompt') &&
    normalized.includes('repo') &&
    normalized.some((cell) => cell === 'rubrics' || cell === 'rubric') &&
    normalized.some((cell) => cell === '评分')
  );
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

function escapeTsvCell(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!/[\t\n"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildRawTextWithRubricsCell(parseResult, rubricsText) {
  const row = [...(parseResult?.row || [])];
  if (row.length < 6) return null;
  const nextRow = [row[0] || '', row[1] || '', row[2] || '', rubricsText, row[4] || '', row.slice(5).join('\n') || ''];
  return nextRow.map(escapeTsvCell).join('\t');
}

function parseRawRow(rawText) {
  const clean = stripCodeFence(rawText);
  const tabRow = pickDataRow(parseDelimitedRows(clean, '\t'));
  let row = tabRow;
  let delimiterName = 'Tab';

  if (row.length < 6) {
    const pipeRow = pickDataRow(parseDelimitedRows(clean, '|'));
    if (pipeRow.length >= row.length) {
      row = pipeRow;
      delimiterName = '竖线';
    }
  }

  const data =
    row.length >= 6
      ? {
          prompt: row[0] || '',
          repo: row[1] || '',
          taskType: row[2] || '',
          rubrics: row[3] || '',
          score: row[4] || '',
          note: row.slice(5).join('\n') || '',
        }
      : EMPTY_DATA;

  if (row.length !== 6) {
    return {
      ok: false,
      delimiterName,
      row,
      data,
      errors: [
        row.length < 6
          ? `只解析到 ${row.length} 列，需要 6 列。`
          : `解析到 ${row.length} 列，多出的列已合并到备注。`,
      ],
    };
  }

  return { ok: true, delimiterName, row, data, errors: [] };
}

function parseRepoList(repoText) {
  const value = trimCell(repoText);
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch (error) {
    // Fall back to loose URL extraction.
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
    .map((match) => ({ number: Number(match[1]), text: match[2].trim() }))
    .filter((item) => item.text);
  if (numbered.length) return numbered;

  return [...text.matchAll(/^\s*[-*]\s+(.+)$/gm)]
    .map((match, index) => ({ number: index + 1, text: match[1].trim() }))
    .filter((item) => item.text);
}

function parseScoreMatrix(scoreText) {
  const original = stripCodeFence(scoreText);
  if (!original) {
    return { ok: false, matrix: null, errors: ['评分列为空，需要填写 0/1 二维数组。'] };
  }

  if (/[，；]/.test(original)) {
    return { ok: false, matrix: null, errors: ['评分列包含中文逗号或中文分号，二维数组必须使用英文逗号。'] };
  }

  let value = original;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return {
      ok: false,
      matrix: null,
      errors: [`评分列不是合法 JSON 二维数组：${error.message}`],
    };
  }

  const errors = [];
  if (!Array.isArray(parsed)) {
    return { ok: false, matrix: parsed, errors: ['评分列顶层必须是数组，例如 [[1,0],[1,1]]。'] };
  }

  parsed.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      errors.push(`第 ${rowIndex + 1} 行不是数组。`);
      return;
    }
    row.forEach((valueItem, colIndex) => {
      if (!(valueItem === 0 || valueItem === 1)) {
        errors.push(`第 ${rowIndex + 1} 行第 ${colIndex + 1} 列不是 0 或 1。`);
      }
    });
  });

  return { ok: errors.length === 0, matrix: parsed, errors };
}

function validateData(data) {
  const repos = parseRepoList(data.repo);
  const rubrics = parseRubricItems(data.rubrics);
  const score = parseScoreMatrix(data.score);
  const matrix = Array.isArray(score.matrix) ? score.matrix : null;
  const errors = [...score.errors];
  const warnings = [];

  if (!repos.length) warnings.push('repo 列未解析到链接。');
  if (!rubrics.length) warnings.push('rubrics 列未解析到编号条目。');

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

  return { repos, rubrics, score, matrix, errors, warnings };
}

function getOriginalScore(matrix, repoIndex, rubricIndex) {
  const value = matrix?.[repoIndex]?.[rubricIndex];
  return value === 0 || value === 1 ? value : null;
}

function createReviewState(repos, rubrics, matrix, noteText, previous = {}) {
  const remarkIssues = parseRemarkIssues(noteText);
  return {
    promptRubricIssues: previous.promptRubricIssues || '',
    rubricIssueOpen: previous.rubricIssueOpen || {},
    finalNote: previous.finalNote || '',
    pages: repos.map((_, repoIndex) => {
      const previousPage = previous.pages?.[repoIndex] || {};
      return {
        visited: Boolean(previousPage.visited),
        pageNote: previousPage.pageNote || '',
        checks: rubrics.map((_, rubricIndex) => {
          const originalScore = getOriginalScore(matrix, repoIndex, rubricIndex);
          const previousCheck = previousPage.checks?.[rubricIndex];
          const seededIssue = remarkIssues.get(`${repoIndex}:${rubricIndex}`) || '';

          return {
            expected: previousCheck?.expected ?? originalScore,
            confirmed: Boolean(previousCheck?.confirmed),
            issue: previousCheck?.issue ?? '',
            annotationNote: previousCheck?.annotationNote ?? seededIssue,
            noteOpen: Boolean(previousCheck?.noteOpen),
          };
        }),
      };
    }),
  };
}

function splitIssueLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean);
}

function parseRubricQualityIssues(value) {
  const issueMap = new Map();

  splitIssueLines(value).forEach((line) => {
    const match = line.match(/^第\s*(\d+)\s*(?:条|个)\s*rub(?:rics|tics)?\s*->\s*(.+)$/i);
    if (!match) return;
    issueMap.set(Number(match[1]) - 1, match[2].trim());
  });

  return issueMap;
}

function formatRubricQualityIssue(rubricIndex, note) {
  return `- 第${rubricIndex + 1}条rubrics -> ${String(note || '').trim()}`;
}

function updateRubricQualityIssueText(text, rubricIndex, note) {
  const nextNote = String(note || '').trim();
  let found = false;
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
    const body = line.trim().replace(/^[-*]\s*/, '');
    const match = body.match(/^第\s*(\d+)\s*(?:条|个)\s*rub(?:rics|tics)?\s*->\s*(.*)$/i);
    if (!match || Number(match[1]) - 1 !== rubricIndex) return [line];
    found = true;
    return nextNote ? [formatRubricQualityIssue(rubricIndex, nextNote)] : [];
  });

  if (!found && nextNote) lines.push(formatRubricQualityIssue(rubricIndex, nextNote));
  return lines.join('\n');
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
  let codeFence = null;
  let codeLines = [];

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
      flushList();
      codeFence = fence[1];
      codeLines = [];
      return;
    }

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

  flushCode();
  flushList();
  return blocks;
}

function buildUpdatedMatrix(review, repos, rubrics, matrix) {
  return repos.map((_, repoIndex) =>
    rubrics.map((_, rubricIndex) => {
      const expected = review.pages?.[repoIndex]?.checks?.[rubricIndex]?.expected;
      if (expected === 0 || expected === 1) return expected;
      return getOriginalScore(matrix, repoIndex, rubricIndex) ?? 0;
    }),
  );
}

function buildQcComment(review, repos, rubrics, matrix) {
  const lines = [];
  const promptRubricIssues = String(review.promptRubricIssues || '').trim();

  splitIssueLines(promptRubricIssues).forEach((issue) => {
    lines.push(`- ${issue}`);
  });

  repos.forEach((_, repoIndex) => {
    const page = review.pages?.[repoIndex];
    if (!page) return;
    const rubricIssues = [];

    splitIssueLines(page.pageNote).forEach((issue) => {
      lines.push(`- 第${repoIndex + 1}个页面 -> 页面整体问题 -> ${issue}`);
    });

    rubrics.forEach((rubric, rubricIndex) => {
      const check = page.checks?.[rubricIndex];
      if (!check) return;

      const originalScore = getOriginalScore(matrix, repoIndex, rubricIndex);
      const expectedScore = check.expected;
      const rubricNumber = rubric.number || rubricIndex + 1;
      const hasMismatch = (expectedScore === 0 || expectedScore === 1) && originalScore !== expectedScore;
      const hasQcNote = hasMismatch || check.noteOpen;

      if (hasQcNote) {
        const reason = check.issue.trim() || '未填写质检理由';
        const scoreCorrection = hasMismatch ? `【分数应修改为${expectedScore}分】` : '';
        rubricIssues.push(`第${rubricNumber}个rubrics -> ${reason}${scoreCorrection}`);
      }
    });

    if (rubricIssues.length) {
      lines.push(`- 第${repoIndex + 1}个页面 -> ${rubricIssues.join('；')}`);
    }
  });

  splitIssueLines(review.finalNote).forEach((issue) => {
    lines.push(`- 其他质检问题 -> ${issue}`);
  });

  return lines.length ? lines.join('\n') : '- 合格';
}

function buildRubricsReviewPrompt(data) {
  const fence = '````';
  const exampleFence = '```';

  return [
    '我现在要完成一项任务，我会给你一段prompt和一段rubrics，我需要你根据rules给出具有结构性的结论。',
    '下面我会给你prompt、rubrics和rules：',
    'prompt：',
    '',
    fence,
    data.prompt.trim(),
    fence,
    '',
    'rubrics:',
    '',
    fence,
    data.rubrics.trim(),
    fence,
    '',
    'rules:',
    '',
    fence,
    RUBRICS_RULES,
    fence,
    '',
    '下面给你讲一下你要干的事情：',
    '',
    '1. rules是任务目标的定义，是任务的执行规范。',
    '',
    '2. prompt是原始的输入材料。',
    '',
    '3. rubrics是对原始输入材料按照rules规范进行处理后得到的输出。',
    '',
    '4. 你的任务就是，核对rubrics的正确性，你要严格执行rules的规范去检查rubrics的质量。',
    '',
    '5. 如果rubrics没有问题，就输出 ”合格“。',
    '',
    '6. 如果rubrics有问题，就输出具体问题的描述，输出描述的要求如下：',
    '',
    '   1. 使用中肯、清晰、明确的描述，直接明了指出问题以及原因。',
    '',
    '   2. 多个错误点使用“-【空格】【描述】【回车】”的格式输出，描述直接用一句话描述出问题以及原因，不要使用“-【总结】：【具体描述】”这样的格式进行回答。',
    '',
    '   3. 不要有任何多余的字符输出，只输出给定模板的内容。',
    '',
    '   4. 不要包含任何人称代词，不要出现任何对话语境，只需要机械的输出规范的数据。',
    '',
    '   5. 下面是输出示例（仅供参考）：',
    '',
    `      ${exampleFence}`,
    '      - rubrics 未提及游戏标题《几何防线》',
    '      - prompt 明确要求"用 React 框架实现"，但 rubrics 未包含',
    '      - 按规则，不满 10 条时中文要求需单独列为一条，但当前 rubrics 未包含',
    '      - 第 1 条rubrics缺少"点射塔（正方形）、溅射塔（圆形）、减速塔（三角形）"的具体类型对应',
    '      - 第 8 条rubrics缺少失败条件描述（敌人到达基地，消耗完所有生命值）',
    `      ${exampleFence}`,
  ].join('\n');
}

function buildRubricsReviewTemplateOutput(template, data) {
  return String(template || '')
    .replaceAll('&{prompt}', data.prompt || '')
    .replaceAll('&{rubrics}', data.rubrics || '');
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
    // Fall back to direct browser fetch below.
  }

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const htmlText = await response.text();
  return extractPageTitle(htmlText);
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

function CombinedFloatingPanel({
  panel,
  prompt,
  note,
  currentRepoNote,
  onDragStart,
  onSplitStart,
  onResizeStart,
  onToggleMinimize,
  onPromptModeChange,
  onNoteModeChange,
  onBeautifyNoteChange,
}) {
  const leftWidth = Math.round(panel.width * panel.split);
  const rightWidth = Math.max(120, panel.width - leftWidth - 9);
  const rawNoteText = panel.noteMode === 'all' ? note : currentRepoNote;
  const formattedNoteText = panel.beautifyNote ? formatRemarkTree(rawNoteText) : '';
  const noteText = formattedNoteText || rawNoteText;
  const emptyNoteText = panel.noteMode === 'all' ? '未解析备注' : '当前repo未解析到备注';

  return (
    <aside
      className={`floating-panel combined ${panel.minimized ? 'minimized' : ''}`}
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.minimized ? undefined : panel.width,
        height: panel.minimized ? undefined : panel.height,
      }}
    >
      <div className="floating-panel-head" onPointerDown={onDragStart} onDoubleClick={onToggleMinimize}>
        <span>
          <Move size={13} />
          <FileText size={14} />
          <strong>Prompt / 备注</strong>
        </span>
        {!panel.minimized && (
          <div className="floating-head-actions" onPointerDown={(event) => event.stopPropagation()}>
            <div className="mini-segmented" aria-label="Prompt 显示模式">
              <button
                type="button"
                className={panel.promptMode === 'raw' ? 'active' : ''}
                onClick={() => onPromptModeChange('raw')}
              >
                原格式
              </button>
              <button
                type="button"
                className={panel.promptMode === 'markdown' ? 'active' : ''}
                onClick={() => onPromptModeChange('markdown')}
              >
                Markdown
              </button>
            </div>
          </div>
        )}
        <button
          className="icon-button"
          type="button"
          title={panel.minimized ? '展开' : '最小化'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onToggleMinimize}
        >
          {panel.minimized ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
        </button>
      </div>
      {!panel.minimized && (
        <>
          <div className="combined-panel-body">
            <section className="combined-pane prompt-pane" style={{ width: leftWidth }}>
              <div className="pane-title">原始 Prompt</div>
              <div className={`prompt-content ${panel.promptMode === 'markdown' ? 'markdown' : ''}`}>
                {panel.promptMode === 'markdown' ? renderMarkdownBlocks(prompt) : <pre>{prompt || '未解析 prompt'}</pre>}
              </div>
            </section>
            <div
              className="splitter"
              role="separator"
              aria-label="调整 Prompt 和备注宽度"
              tabIndex={0}
              onPointerDown={onSplitStart}
            />
            <section className="combined-pane note-pane" style={{ width: rightWidth }}>
              <div className="pane-title pane-title-with-actions">
                <span>备注</span>
                <div className="note-toolbar">
                  <label className="mini-toggle">
                    <input
                      type="checkbox"
                      checked={panel.beautifyNote !== false}
                      onChange={(event) => onBeautifyNoteChange(event.target.checked)}
                    />
                    格式美化
                  </label>
                  <div className="mini-segmented">
                    <button
                      type="button"
                      className={panel.noteMode === 'all' ? 'active' : ''}
                      onClick={() => onNoteModeChange('all')}
                    >
                      全部备注
                    </button>
                    <button
                      type="button"
                      className={panel.noteMode !== 'all' ? 'active' : ''}
                      onClick={() => onNoteModeChange('current')}
                    >
                      当前repo备注
                    </button>
                  </div>
                </div>
              </div>
              <pre>{noteText || emptyNoteText}</pre>
            </section>
          </div>
          <div className="panel-resize-handle" title="调整窗口大小" onPointerDown={onResizeStart} />
        </>
      )}
    </aside>
  );
}

function AnimatedIssueTextarea({ className, value, onChange, placeholder }) {
  const wrapRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const element = textareaRef.current;
    if (!wrap || !element) return undefined;

    const targetHeight = element.offsetHeight;
    gsap.killTweensOf(wrap);
    gsap.set(wrap, {
      autoAlpha: 0,
      height: 0,
      marginTop: 0,
      overflow: 'hidden',
    });

    const animation = gsap.to(wrap, {
      autoAlpha: 1,
      height: targetHeight,
      marginTop: 8,
      duration: 0.26,
      ease: 'power2.out',
      onComplete: () => {
        gsap.set(wrap, { height: 'auto', overflow: 'visible' });
      },
    });

    return () => animation.kill();
  }, []);

  return (
    <div className="issue-textarea-wrap" ref={wrapRef}>
      <textarea
        ref={textareaRef}
        className={className}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
    </div>
  );
}

function PromptTemplateModal({ template, previewText, onChange, onClose, onReset }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="template-modal"
        role="dialog"
        aria-modal="true"
        aria-label="rubrics质检提示词设置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="template-modal-head">
          <div>
            <h2>rubrics质检提示词设置</h2>
            <p>占位符：&amp;{'{prompt}'} / &amp;{'{rubrics}'}</p>
          </div>
          <div className="button-row">
            <button className="ghost-button" type="button" onClick={onReset}>
              <RotateCcw size={16} />
              恢复初始模板
            </button>
            <button className="icon-button" type="button" title="关闭" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="template-modal-body">
          <section className="template-editor">
            <div className="template-editor-title">原始模板</div>
            <textarea
              value={template}
              onChange={(event) => onChange(event.target.value)}
              spellCheck="false"
            />
          </section>
          <section className="template-preview">
            <div className="template-preview-title">Markdown预览</div>
            <div className="prompt-content markdown">{renderMarkdownBlocks(previewText || ' ')}</div>
          </section>
        </div>
      </section>
    </div>
  );
}

function RubricsFormatModal({ value, onChange, onConfirm, onClose }) {
  const issueNumbers = getRubricNumberSpacingIssueNumbers(value);
  const issueText = issueNumbers.length
    ? `列表序号后面需要保留一个空格，第${issueNumbers.join('、')}个rubrics序号后没有空格。`
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

function App() {
  const [rawText, setRawText] = useState('');
  const [data, setData] = useState(EMPTY_DATA);
  const [parseResult, setParseResult] = useState(null);
  const [review, setReview] = useState(() => createReviewState([], [], null, ''));
  const [selectedRepo, setSelectedRepo] = useState(0);
  const [frameKey, setFrameKey] = useState(0);
  const [toast, setToast] = useState('');
  const [floatingPanel, setFloatingPanel] = useState(INITIAL_FLOATING_PANEL);
  const [panelInteraction, setPanelInteraction] = useState(null);
  const [isFrameFullscreen, setIsFrameFullscreen] = useState(false);
  const [repoTitles, setRepoTitles] = useState({});
  const [reviewPromptTemplate, setReviewPromptTemplate] = useState(DEFAULT_RUBRICS_REVIEW_TEMPLATE);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [rubricsFormatModal, setRubricsFormatModal] = useState(null);
  const [showAnnotationNotes, setShowAnnotationNotes] = useState(true);
  const rubricListRef = useRef(null);
  const rawParseTimerRef = useRef(null);

  const parsed = useMemo(() => validateData(data), [data]);
  const isRawInputValid = Boolean(parseResult?.ok) && parsed.errors.length === 0 && parsed.warnings.length === 0;
  const repoKey = useMemo(() => parsed.repos.join('\n'), [parsed.repos]);
  const annotationNotes = useMemo(() => parseRemarkIssues(data.note), [data.note]);
  const currentRepoNote = useMemo(() => extractPageRemarkText(data.note, selectedRepo), [data.note, selectedRepo]);
  const rubricQualityIssues = useMemo(() => parseRubricQualityIssues(review.promptRubricIssues), [review.promptRubricIssues]);
  const currentRepoUrl = parsed.repos[selectedRepo] || '';
  const currentPage = review.pages?.[selectedRepo];
  const generatedComment = useMemo(
    () => buildQcComment(review, parsed.repos, parsed.rubrics, parsed.matrix),
    [review, parsed.repos, parsed.rubrics, parsed.matrix],
  );
  const updatedMatrix = useMemo(
    () => buildUpdatedMatrix(review, parsed.repos, parsed.rubrics, parsed.matrix),
    [review, parsed.repos, parsed.rubrics, parsed.matrix],
  );
  const updatedMatrixText = JSON.stringify(updatedMatrix);
  const reviewPromptText = useMemo(
    () => buildRubricsReviewTemplateOutput(reviewPromptTemplate, data),
    [reviewPromptTemplate, data],
  );

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      setRawText(saved.rawText || '');
      setData({ ...EMPTY_DATA, ...(saved.data || {}) });
      setParseResult(saved.parseResult || null);
      setReview(saved.review || createReviewState([], [], null, ''));
      setSelectedRepo(saved.selectedRepo || 0);
      setShowAnnotationNotes(saved.showAnnotationNotes !== false);
      setReviewPromptTemplate(saved.reviewPromptTemplate || DEFAULT_RUBRICS_REVIEW_TEMPLATE);
      const loadedFloatingPanel =
        saved.floatingPanel ||
          (saved.floatingPanels?.prompt
            ? { ...INITIAL_FLOATING_PANEL, ...saved.floatingPanels.prompt }
            : INITIAL_FLOATING_PANEL);
      setFloatingPanel({
        ...INITIAL_FLOATING_PANEL,
        ...loadedFloatingPanel,
        promptMode: loadedFloatingPanel.promptMode || 'markdown',
        noteMode: loadedFloatingPanel.noteMode || 'current',
        beautifyNote: loadedFloatingPanel.beautifyNote !== false,
      });
      setRepoTitles(saved.repoTitleVersion === REPO_TITLE_STATE_VERSION ? saved.repoTitles || {} : {});
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    const payload = {
      rawText,
      data,
      parseResult,
      review,
      selectedRepo,
      showAnnotationNotes,
      reviewPromptTemplate,
      floatingPanel,
      floatingPanelVersion: FLOATING_PANEL_STATE_VERSION,
      repoTitles,
      repoTitleVersion: REPO_TITLE_STATE_VERSION,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [rawText, data, parseResult, review, selectedRepo, showAnnotationNotes, reviewPromptTemplate, floatingPanel, repoTitles]);

  useEffect(() => {
    if (selectedRepo >= parsed.repos.length) setSelectedRepo(0);
  }, [parsed.repos.length, selectedRepo]);

  useEffect(
    () => () => {
      if (rawParseTimerRef.current) window.clearTimeout(rawParseTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!rubricListRef.current || !currentPage) return undefined;
    const cards = gsap.utils.toArray(rubricListRef.current.querySelectorAll('.rubric-item'));
    if (!cards.length) return undefined;

    gsap.killTweensOf(cards);
    gsap.set(cards, { autoAlpha: 0, y: 14, scale: 0.985 });
    const animation = gsap.to(cards, {
      autoAlpha: 1,
      y: 0,
      scale: 1,
      duration: 0.34,
      stagger: 0.035,
      ease: 'power2.out',
      clearProps: 'transform,opacity,visibility',
    });

    return () => animation.kill();
  }, [selectedRepo, parsed.rubrics.length]);

  useEffect(() => {
    function fitFloatingPanelToViewport() {
      setFloatingPanel((previous) => {
        const width = clamp(previous.width, 320, Math.max(320, window.innerWidth - 16));
        const height = clamp(previous.height, 280, Math.max(280, window.innerHeight - 16));
        return {
          ...previous,
          width,
          height,
          x: clamp(previous.x, 8, Math.max(8, window.innerWidth - 180)),
          y: clamp(previous.y, 8, Math.max(8, window.innerHeight - 42)),
        };
      });
    }

    fitFloatingPanelToViewport();
    window.addEventListener('resize', fitFloatingPanelToViewport);
    return () => window.removeEventListener('resize', fitFloatingPanelToViewport);
  }, []);

  useEffect(() => {
    if (!parsed.repos.length) {
      setRepoTitles({});
      return undefined;
    }

    const controller = new AbortController();
    setRepoTitles((previous) => {
      const next = {};
      parsed.repos.forEach((url) => {
        if (previous[url]) next[url] = previous[url];
      });
      return next;
    });

    parsed.repos.forEach((url) => {
      fetchPageTitle(url, controller.signal)
        .then((title) => {
          if (!title) return;
          setRepoTitles((previous) => ({ ...previous, [url]: title }));
        })
        .catch(() => {});
    });

    return () => controller.abort();
  }, [repoKey]);

  useEffect(() => {
    if (!panelInteraction) return undefined;

    function handlePointerMove(event) {
      setFloatingPanel((previous) => {
        if (panelInteraction.type === 'move') {
          const maxX = Math.max(8, window.innerWidth - 180);
          const maxY = Math.max(8, window.innerHeight - 42);
          return {
            ...previous,
            x: clamp(panelInteraction.originX + event.clientX - panelInteraction.startX, 8, maxX),
            y: clamp(panelInteraction.originY + event.clientY - panelInteraction.startY, 8, maxY),
          };
        }

        if (panelInteraction.type === 'split') {
          const delta = event.clientX - panelInteraction.startX;
          const split = (panelInteraction.leftWidth + delta) / panelInteraction.width;
          return { ...previous, split: clamp(split, 0.28, 0.72) };
        }

        if (panelInteraction.type === 'resize') {
          const width = clamp(panelInteraction.originWidth + event.clientX - panelInteraction.startX, 320, window.innerWidth - previous.x - 8);
          const height = clamp(panelInteraction.originHeight + event.clientY - panelInteraction.startY, 280, window.innerHeight - previous.y - 8);
          return { ...previous, width, height };
        }

        return previous;
      });
    }

    function handlePointerUp() {
      setPanelInteraction(null);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [panelInteraction]);

  function parseAndApply(text = rawText, { showToast = true } = {}) {
    if (rawParseTimerRef.current) window.clearTimeout(rawParseTimerRef.current);
    rawParseTimerRef.current = null;
    const result = parseRawRow(text);
    const nextData = result.data || EMPTY_DATA;
    const nextParsed = validateData(nextData);
    setParseResult(result);
    setData(nextData);
    setSelectedRepo(0);
    setFrameKey((key) => key + 1);
    setRepoTitles({});
    setReview(createReviewState(nextParsed.repos, nextParsed.rubrics, nextParsed.matrix, nextData.note));
    if (result.ok && hasRubricNumberSpacingIssue(nextData.rubrics)) {
      setRubricsFormatModal({ draft: nextData.rubrics });
    } else {
      setRubricsFormatModal(null);
    }
    if (showToast) setToast(result.ok ? `已按 ${result.delimiterName} 解析 6 列` : result.errors.join(' '));
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

  function clearAll() {
    if (rawParseTimerRef.current) window.clearTimeout(rawParseTimerRef.current);
    rawParseTimerRef.current = null;
    setRawText('');
    setData(EMPTY_DATA);
    setParseResult(null);
    setReview(createReviewState([], [], null, ''));
    setSelectedRepo(0);
    setPanelInteraction(null);
    setIsFrameFullscreen(false);
    setRepoTitles({});
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

  function startFloatingDrag(event) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPanelInteraction({
      type: 'move',
      startX: event.clientX,
      startY: event.clientY,
      originX: floatingPanel.x,
      originY: floatingPanel.y,
    });
    event.preventDefault();
  }

  function startSplitDrag(event) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPanelInteraction({
      type: 'split',
      startX: event.clientX,
      width: floatingPanel.width,
      leftWidth: floatingPanel.width * floatingPanel.split,
    });
    event.preventDefault();
  }

  function startResizeDrag(event) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPanelInteraction({
      type: 'resize',
      startX: event.clientX,
      startY: event.clientY,
      originWidth: floatingPanel.width,
      originHeight: floatingPanel.height,
    });
    event.preventDefault();
  }

  function toggleFloatingPanel() {
    setFloatingPanel((previous) => ({ ...previous, minimized: !previous.minimized }));
  }

  function setPromptMode(promptMode) {
    setFloatingPanel((previous) => ({ ...previous, promptMode }));
  }

  function setNoteMode(noteMode) {
    setFloatingPanel((previous) => ({ ...previous, noteMode }));
  }

  function setBeautifyNote(beautifyNote) {
    setFloatingPanel((previous) => ({ ...previous, beautifyNote }));
  }

  function updatePage(repoIndex, patch) {
    setReview((previous) => {
      const pages = [...(previous.pages || [])];
      pages[repoIndex] = { ...pages[repoIndex], ...patch };
      return { ...previous, pages };
    });
  }

  function updateCheck(repoIndex, rubricIndex, patch) {
    setReview((previous) => {
      const pages = [...(previous.pages || [])];
      const page = { ...pages[repoIndex] };
      const checks = [...(page.checks || [])];
      checks[rubricIndex] = { ...checks[rubricIndex], ...patch };
      page.checks = checks;
      pages[repoIndex] = page;
      return { ...previous, pages };
    });
  }

  function toggleRubricIssue(rubricIndex) {
    setReview((previous) => ({
      ...previous,
      rubricIssueOpen: {
        ...(previous.rubricIssueOpen || {}),
        [rubricIndex]: !previous.rubricIssueOpen?.[rubricIndex],
      },
    }));
  }

  function updateRubricQualityIssue(rubricIndex, note) {
    setReview((previous) => ({
      ...previous,
      promptRubricIssues: updateRubricQualityIssueText(previous.promptRubricIssues, rubricIndex, note),
      rubricIssueOpen: {
        ...(previous.rubricIssueOpen || {}),
        [rubricIndex]: true,
      },
    }));
  }

  function confirmOriginalForPage() {
    if (!currentPage) return;
    setReview((previous) => {
      const pages = [...previous.pages];
      const page = { ...pages[selectedRepo] };
      page.visited = true;
      page.checks = parsed.rubrics.map((_, rubricIndex) => {
        const originalScore = getOriginalScore(parsed.matrix, selectedRepo, rubricIndex);
        const previousCheck = page.checks?.[rubricIndex] || {};
        return {
          ...previousCheck,
          expected: originalScore ?? previousCheck.expected ?? null,
          confirmed: originalScore !== null,
        };
      });
      pages[selectedRepo] = page;
      return { ...previous, pages };
    });
  }

  function resetCurrentPage() {
    setReview((previous) => {
      const pages = [...previous.pages];
      const page = { ...pages[selectedRepo] };
      page.visited = false;
      page.pageNote = '';
      page.checks = parsed.rubrics.map((_, rubricIndex) => {
        const originalScore = getOriginalScore(parsed.matrix, selectedRepo, rubricIndex);
        return { expected: originalScore, confirmed: false, issue: '', noteOpen: false };
      });
      pages[selectedRepo] = page;
      return { ...previous, pages };
    });
  }

  async function copyAndToast(text, message) {
    try {
      await copyText(text);
      setToast(message);
    } catch (error) {
      setToast('复制失败，请手动选中文本复制。');
    }
  }

  function captureIframeTitle(event) {
    if (!currentRepoUrl) return;
    try {
      const title = event.currentTarget.contentDocument?.title?.trim();
      if (title) setRepoTitles((previous) => ({ ...previous, [currentRepoUrl]: title }));
    } catch (error) {
      // Cross-origin iframes cannot expose their document title.
    }
  }

  return (
    <div className={`app-shell ${isRawInputValid ? '' : 'input-invalid'} ${panelInteraction ? 'dragging-panel' : ''}`}>
      <main className="workbench-grid">
        <section className="left-workspace">
          <section className="input-panel">
            <div className="section-head input-toolbar">
              <div>
                <h1>Rubrics 质检工作台</h1>
                <div className="toolbar-subline">
                  <p>prompt / repo / 任务类型 / rubrics / 评分 / 备注</p>
                  <div className="parse-line inline">
                    {parseResult ? (
                      <StatusBadge type={parseResult.ok ? 'success' : 'warning'}>
                        {parseResult.ok ? `已解析：${parseResult.delimiterName}` : parseResult.errors.join(' ')}
                      </StatusBadge>
                    ) : (
                      <StatusBadge>等待解析</StatusBadge>
                    )}
                    {parsed.errors.map((error) => (
                      <StatusBadge type="danger" key={error}>
                        {error}
                      </StatusBadge>
                    ))}
                    {parsed.warnings.map((warning) => (
                      <StatusBadge type="warning" key={warning}>
                        {warning}
                      </StatusBadge>
                    ))}
                  </div>
                </div>
              </div>
              <div className="button-row">
                <div className="split-capsule">
                  <button
                    className="split-capsule-main"
                    type="button"
                    onClick={() => copyAndToast(reviewPromptText, '已复制 rubrics 质检提示词')}
                  >
                    <Clipboard size={16} />
                    rubrics质检提示词
                  </button>
                  <button
                    className="split-capsule-icon"
                    type="button"
                    title="设置rubrics质检提示词"
                    onClick={() => setIsTemplateModalOpen(true)}
                  >
                    <Settings size={16} />
                  </button>
                </div>
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
              placeholder="在这里粘贴整行 6 列数据"
              spellCheck="false"
            />
          </section>

          <section className={`viewer-panel ${isFrameFullscreen ? 'frame-fullscreen' : ''}`}>
            <div className="repo-list">
              {parsed.repos.length ? (
                parsed.repos.map((repoUrl, index) => {
                  const page = review.pages?.[index];
                  const issueCount = page?.checks?.filter((check) => check.expected === 0).length || 0;
                  return (
                    <button
                      className={`repo-item ${selectedRepo === index ? 'active' : ''}`}
                      type="button"
                      key={repoUrl}
                      onClick={() => setSelectedRepo(index)}
                    >
                      <span className="repo-index">{index + 1}</span>
                      <span className="repo-text">{repoTitles[repoUrl] || labelForRepo(repoUrl, index)}</span>
                      {issueCount > 0 && <span className="issue-pill">{issueCount}</span>}
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
              <button
                className="icon-button"
                type="button"
                title="刷新预览"
                onClick={() => setFrameKey((key) => key + 1)}
                disabled={!currentRepoUrl}
              >
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

        <section className="review-panel">
          <div className="section-head compact">
            <div>
              <h2>当前页面核查</h2>
              <p>{parsed.rubrics.length ? `第 ${selectedRepo + 1} 个页面，共 ${parsed.rubrics.length} 条 rubric` : '等待解析 rubrics'}</p>
            </div>
            <div className="button-row">
              <label className="mini-toggle review-toggle">
                <input
                  type="checkbox"
                  checked={showAnnotationNotes}
                  onChange={(event) => setShowAnnotationNotes(event.target.checked)}
                />
                显示标注备注
              </label>
              <button className="ghost-button" type="button" onClick={confirmOriginalForPage} disabled={!currentPage}>
                <Check size={16} />
                确认原评分
              </button>
              <button className="ghost-button" type="button" onClick={resetCurrentPage} disabled={!currentPage}>
                <RotateCcw size={16} />
                重置本页
              </button>
            </div>
          </div>

          {currentPage ? (
            <>
              <div className="review-top-inputs">
                <div className="quick-issue-row">
                  <label className="stacked-label">
                    Rubrics质量问题
                    <textarea
                      value={review.promptRubricIssues}
                      onChange={(event) => setReview((previous) => ({ ...previous, promptRubricIssues: event.target.value }))}
                      placeholder="粘贴 AI 核查 rubrics 后给出的质量问题"
                    />
                  </label>
                  <label className="stacked-label">
                    页面整体问题
                    <textarea
                      value={currentPage.pageNote}
                      onChange={(event) => updatePage(selectedRepo, { pageNote: event.target.value })}
                    placeholder="记录当前页面的整体异常，例如无法打开、白屏、核心交互不可用"
                  />
                </label>
              </div>
              </div>

              <div className="review-body">
                <div className="rubric-column">
                <div className="rubric-list" ref={rubricListRef}>
                  {parsed.rubrics.map((rubric, rubricIndex) => {
                    const check = currentPage.checks?.[rubricIndex] || {};
                    const originalScore = getOriginalScore(parsed.matrix, selectedRepo, rubricIndex);
                    const hasMismatch =
                      (check.expected === 0 || check.expected === 1) &&
                      originalScore !== check.expected;
                    const annotationNote =
                      check.annotationNote || annotationNotes.get(`${selectedRepo}:${rubricIndex}`) || '';
                    const displayedAnnotationNote =
                      annotationNote || (originalScore === 0 ? EMPTY_PARSED_ZERO_NOTE_MESSAGE : '');
                    const rubricQualityIssue = rubricQualityIssues.get(rubricIndex) || '';
                    const showRubricIssue = Boolean(review.rubricIssueOpen?.[rubricIndex] || rubricQualityIssue);
                    const showQcReason = hasMismatch || check.noteOpen;
                    const needsIssue = showQcReason && !check.issue?.trim();

                    return (
                      <article
                        className={`rubric-item ${hasMismatch ? 'mismatch' : ''}`}
                        key={`${selectedRepo}-${rubric.number}-${rubric.text}`}
                      >
                        <div className="rubric-head">
                          <div className="rubric-head-main">
                            <strong>第 {rubric.number || rubricIndex + 1} 条Rubrics</strong>
                            <p className="rubric-text">{rubric.text}</p>
                            <button
                              type="button"
                              className={`rubric-note-toggle ${showRubricIssue ? 'active' : ''}`}
                              onClick={() => toggleRubricIssue(rubricIndex)}
                            >
                              rubrics备注
                            </button>
                          </div>
                          <div className="score-tags">
                            <StatusBadge type={originalScore === 0 ? 'danger' : originalScore === 1 ? 'success' : 'neutral'}>
                              原评分 {originalScore ?? '缺失'}
                            </StatusBadge>
                            <StatusBadge type={check.confirmed ? 'success' : 'warning'}>
                              {check.confirmed ? '已确认' : '未确认'}
                            </StatusBadge>
                        </div>
                      </div>

                      {showRubricIssue && (
                        <AnimatedIssueTextarea
                          className="rubric-quality-textarea"
                          value={rubricQualityIssue}
                          onChange={(event) => updateRubricQualityIssue(rubricIndex, event.target.value)}
                          placeholder="填写 rubrics 修改建议，此内容会同步到上方 Rubrics质量问题"
                        />
                      )}

                      <div className="segmented">
                          <button
                            type="button"
                            className={check.expected === 1 ? 'active pass' : ''}
                            onClick={() => updateCheck(selectedRepo, rubricIndex, { expected: 1, confirmed: true })}
                          >
                            <Check size={15} />
                            应为 1
                          </button>
                          <button
                            type="button"
                            className={check.expected === 0 ? 'active fail' : ''}
                            onClick={() => updateCheck(selectedRepo, rubricIndex, { expected: 0, confirmed: true })}
                          >
                            <X size={15} />
                            应为 0
                          </button>
                        <button
                          type="button"
                          className={check.noteOpen && !hasMismatch ? 'active note' : ''}
                          onClick={() => updateCheck(selectedRepo, rubricIndex, { noteOpen: !check.noteOpen, confirmed: true })}
                        >
                          添加备注
                        </button>
                      </div>

                      {showAnnotationNotes && displayedAnnotationNote && (
                        <div className="annotation-note">
                          <strong>标注备注</strong>
                          <p>{displayedAnnotationNote}</p>
                        </div>
                      )}

                        {showQcReason && (
                          <>
                            <AnimatedIssueTextarea
                              className={needsIssue ? 'needs-input' : ''}
                              value={check.issue}
                              onChange={(event) => updateCheck(selectedRepo, rubricIndex, { issue: event.target.value })}
                              placeholder={hasMismatch ? '填写改分质检理由，此内容会输出给标注员' : '填写备注修改建议，此内容会输出给标注员'}
                            />
                            <p className="inline-alert">
                              <AlertTriangle size={15} />
                              {hasMismatch ? '原评分与质检结论不一致，需填写质检理由' : '评分未改，将作为备注修改建议输出'}
                            </p>
                          </>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>

                <section className="output-panel">
                  <div className="section-head">
                    <div>
                      <h2>质检输出</h2>
                      <p>输出区固定在右侧</p>
                    </div>
                    <div className="button-row">
                      <button className="primary-button" type="button" onClick={() => copyAndToast(generatedComment, '已复制质检评论')}>
                        <Copy size={16} />
                        复制评论
                      </button>
                      <button className="ghost-button" type="button" onClick={() => copyAndToast(updatedMatrixText, '已复制评分矩阵')}>
                        <Copy size={16} />
                        复制评分
                      </button>
                    </div>
                  </div>

                  <div className="output-grid">
                    <label className="stacked-label">
                      其它质检问题
                      <textarea
                        value={review.finalNote}
                        onChange={(event) => setReview((previous) => ({ ...previous, finalNote: event.target.value }))}
                        placeholder="逐行记录无法归入具体页面或具体 rubric 的问题"
                      />
                    </label>
                    <label className="stacked-label">
                      修正后评分
                      <textarea value={updatedMatrixText} readOnly />
                    </label>
                    <label className="stacked-label output-comment-label">
                      质检评论输出
                      <textarea className="output-textarea" value={generatedComment} readOnly />
                    </label>
                  </div>
                </section>
              </div>
            </>
          ) : (
            <div className="empty-state large">解析数据后开始核查</div>
          )}
        </section>
      </main>

      <CombinedFloatingPanel
        panel={floatingPanel}
        prompt={data.prompt}
        note={data.note}
        currentRepoNote={currentRepoNote}
        onDragStart={startFloatingDrag}
        onSplitStart={startSplitDrag}
        onResizeStart={startResizeDrag}
        onToggleMinimize={toggleFloatingPanel}
        onPromptModeChange={setPromptMode}
        onNoteModeChange={setNoteMode}
        onBeautifyNoteChange={setBeautifyNote}
      />

      {isTemplateModalOpen && (
        <PromptTemplateModal
          template={reviewPromptTemplate}
          previewText={reviewPromptText}
          onChange={setReviewPromptTemplate}
          onClose={() => setIsTemplateModalOpen(false)}
          onReset={() => setReviewPromptTemplate(DEFAULT_RUBRICS_REVIEW_TEMPLATE)}
        />
      )}

      {rubricsFormatModal && (
        <RubricsFormatModal
          value={rubricsFormatModal.draft}
          onChange={(draft) => setRubricsFormatModal((previous) => ({ ...(previous || {}), draft }))}
          onClose={() => setRubricsFormatModal(null)}
          onConfirm={applyRubricsFormatFix}
        />
      )}

      {panelInteraction && <div className="drag-interaction-shield" />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;
