export const FULL_RECORD_COLUMN_COUNT = 19;

export const EMPTY_RAW_RECORD = {
  uid: '',
  prompt: '',
  repo: '',
  taskType: '',
  rubrics: '',
  score: '',
  note: '',
  annotator: '',
  date: '',
  rescan: '',
  supplier: '',
  deliveryBatch: '',
  internalQc: '',
  qcPerson: '',
  qcComment: '',
  internalSample: '',
  samplePerson: '',
  sampleComment: '',
  sampleDate: '',
  variables: {},
};

const FIELD_LABELS = {
  uid: 'uid',
  prompt: 'prompt',
  repo: 'repo',
  taskType: '任务类型',
  rubrics: 'rubrics',
  score: '评分',
  note: '备注',
  annotator: '标注人',
  date: '日期',
  rescan: '回扫',
  supplier: '供应商',
  deliveryBatch: '交付批次',
  internalQc: '内部质检',
  qcPerson: '质检人',
  qcComment: '质检备注',
  internalSample: '内部抽检',
  samplePerson: '抽检人',
  sampleComment: '抽检备注',
  sampleDate: '抽检日期',
};

const SCORE_RELATIVE_FIELDS = [
  'note',
  'annotator',
  'date',
  'rescan',
  'supplier',
  'deliveryBatch',
  'internalQc',
  'qcPerson',
  'qcComment',
  'internalSample',
  'samplePerson',
  'sampleComment',
  'sampleDate',
];

export function trimCell(value) {
  return String(value ?? '').replace(/\u00A0/g, ' ').trim();
}

export function stripCodeFence(value) {
  return String(value || '')
    .replace(/^`{3,4}\s*/g, '')
    .replace(/\s*`{3,4}$/g, '')
    .trim();
}

function stripCodeFenceForRows(value) {
  const text = String(value || '').replace(/^\uFEFF/, '');
  const match = text.match(/^\s*`{3,4}[^\r\n]*\r?\n([\s\S]*?)\r?\n?`{3,4}\s*$/);
  return match ? match[1] : text;
}

function normalizeDelimitedRow(row, delimiter) {
  if (delimiter !== '|') return row;
  const next = [...row];
  if (next[0] === '') next.shift();
  if (next[next.length - 1] === '') next.pop();
  return next;
}

export function parseDelimitedRows(rawText, delimiter) {
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

function looksLikeHeader(row) {
  const normalized = row.map((cell) => cell.trim().toLowerCase());
  return normalized.includes('prompt') && normalized.includes('repo');
}

function pickDataRow(rows) {
  const nonEmpty = rows.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (nonEmpty.length >= 2 && looksLikeHeader(nonEmpty[0])) return nonEmpty[1];
  return nonEmpty[0] || [];
}

function parseRepoLikeList(repoText) {
  const value = trimCell(repoText);
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.some((item) => /^https?:\/\//i.test(String(item)))) {
      return parsed.map(String).filter(Boolean);
    }
  } catch (error) {
    // Fall back to loose URL extraction.
  }

  return value.match(/https?:\/\/[^\s,"'\]\)]+/g) || [];
}

function parseScoreMatrix(scoreText) {
  const original = stripCodeFence(scoreText);
  if (!original || !/^\s*\[/.test(original)) return null;

  try {
    const parsed = JSON.parse(original);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    if (!parsed.every((row) => Array.isArray(row))) return null;
    const values = parsed.flat();
    if (!values.length || !values.every((value) => value === 0 || value === 1)) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function looksLikeScoreCell(cell) {
  return Boolean(parseScoreMatrix(cell));
}

function countRubricNumberedItems(cell) {
  const text = String(cell || '');
  const lineItems = [...text.matchAll(/^\s*\d+\s*[.、)]\s*\S/gm)].length;
  const inlineItems = [...text.matchAll(/(?:^|\s)\d+\s*[.、)]\s*\S/g)].length;
  return Math.max(lineItems, inlineItems);
}

function looksLikeRubricsCell(cell) {
  const value = trimCell(cell);
  if (!value || looksLikeScoreCell(value) || parseRepoLikeList(value).length) return false;
  const count = countRubricNumberedItems(value);
  if (count >= 2) return true;
  return count === 1 && value.length >= 18;
}

function findFirstIndex(row, predicate) {
  const index = row.findIndex((cell) => predicate(cell));
  return index >= 0 ? index : null;
}

function findRubricsIndex(row, repoIndex, scoreIndex) {
  const candidates = row
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell, index }) => index !== repoIndex && index !== scoreIndex && looksLikeRubricsCell(cell))
    .map(({ index }) => index);

  if (scoreIndex !== null) {
    const beforeScore = candidates.filter((index) => index < scoreIndex);
    if (beforeScore.length) return beforeScore.at(-1);
    const fallback = scoreIndex - 1;
    if (fallback >= 0 && fallback !== repoIndex) return fallback;
  }

  if (repoIndex !== null) {
    const afterRepo = candidates.find((index) => index > repoIndex);
    if (afterRepo !== undefined) return afterRepo;
    const fallback = repoIndex + 2;
    if (fallback < row.length && fallback !== scoreIndex) return fallback;
  }

  return candidates[0] ?? null;
}

function findPromptIndex(row, repoIndex, rubricsIndex, scoreIndex) {
  if (repoIndex !== null) {
    for (let index = repoIndex - 1; index >= 0; index -= 1) {
      const value = trimCell(row[index]);
      if (value) return index;
    }
  }

  const upperBound = [rubricsIndex, scoreIndex]
    .filter((index) => index !== null)
    .sort((left, right) => left - right)[0];
  if (upperBound === undefined) return null;

  let best = null;
  for (let index = 0; index < upperBound; index += 1) {
    const value = trimCell(row[index]);
    if (!value || looksLikeRubricsCell(value) || looksLikeScoreCell(value) || parseRepoLikeList(value).length) continue;
    if (best === null || value.length > trimCell(row[best]).length) best = index;
  }
  return best;
}

function findTaskTypeIndex(row, repoIndex, rubricsIndex, scoreIndex) {
  if (repoIndex === null) return null;
  const end = rubricsIndex ?? scoreIndex ?? row.length;
  for (let index = repoIndex + 1; index < end; index += 1) {
    const value = trimCell(row[index]);
    if (!value || looksLikeRubricsCell(value) || looksLikeScoreCell(value) || parseRepoLikeList(value).length) continue;
    if (value.length <= 80) return index;
  }
  return null;
}

function analyzeRow(row) {
  const repoIndex = findFirstIndex(row, (cell) => parseRepoLikeList(cell).length > 0);
  const scoreIndex = findFirstIndex(row, looksLikeScoreCell);
  const rubricsIndex = findRubricsIndex(row, repoIndex, scoreIndex);
  const promptIndex = findPromptIndex(row, repoIndex, rubricsIndex, scoreIndex);
  const taskTypeIndex = findTaskTypeIndex(row, repoIndex, rubricsIndex, scoreIndex);
  const anchorCount = [repoIndex, rubricsIndex, scoreIndex].filter((index) => index !== null).length;

  return {
    repoIndex,
    scoreIndex,
    rubricsIndex,
    promptIndex,
    taskTypeIndex,
    anchorCount,
  };
}

function padRow(row, length) {
  const next = [...row];
  while (next.length < length) next.push('');
  return next;
}

function getCell(row, index) {
  return index === null || index === undefined ? '' : row[index] || '';
}

function putVariable(variables, key, value) {
  variables[key] = value || '';
  const label = FIELD_LABELS[key];
  if (label) variables[label] = value || '';
}

function buildVariables(row, data) {
  const variables = {};
  Object.keys(FIELD_LABELS).forEach((key) => putVariable(variables, key, data[key]));
  row.forEach((value, index) => {
    variables[`col${index + 1}`] = value || '';
    variables[`列${index + 1}`] = value || '';
  });
  return variables;
}

function buildDynamicData(row, analysis) {
  const data = {
    ...EMPTY_RAW_RECORD,
    prompt: getCell(row, analysis.promptIndex),
    repo: getCell(row, analysis.repoIndex),
    taskType: getCell(row, analysis.taskTypeIndex),
    rubrics: getCell(row, analysis.rubricsIndex),
    score: getCell(row, analysis.scoreIndex),
  };

  if (analysis.repoIndex !== null && analysis.promptIndex !== null && analysis.promptIndex === analysis.repoIndex - 1) {
    data.uid = getCell(row, analysis.promptIndex - 1);
  }

  if (analysis.scoreIndex !== null) {
    SCORE_RELATIVE_FIELDS.forEach((key, offset) => {
      data[key] = getCell(row, analysis.scoreIndex + offset + 1);
    });
  }

  data.variables = buildVariables(row, data);
  return data;
}

function scoreCandidate(row, allowTwoColumns) {
  const analysis = analyzeRow(row);
  const simpleTwoScore = allowTwoColumns && row.length >= 2 ? 1 : 0;
  return analysis.anchorCount * 100 + simpleTwoScore * 20 + Math.min(row.length, 30);
}

function parseRow(rawText, delimiter) {
  const clean = stripCodeFenceForRows(rawText);
  return pickDataRow(parseDelimitedRows(clean, delimiter));
}

function chooseBestRow(rawText, allowTwoColumns) {
  const candidates = [
    { row: parseRow(rawText, '\t'), delimiterName: 'Tab' },
    { row: parseRow(rawText, '|'), delimiterName: '竖线' },
  ];

  return candidates.reduce((best, candidate) => {
    const candidateScore = scoreCandidate(candidate.row, allowTwoColumns);
    const bestScore = scoreCandidate(best.row, allowTwoColumns);
    if (candidateScore > bestScore) return candidate;
    if (candidateScore === bestScore && candidate.row.length > best.row.length) return candidate;
    return best;
  });
}

function inferRecordType(row, analysis, allowTwoColumns) {
  if (row.length === 2 && allowTwoColumns) return 'two';
  if (row.length === 6 && analysis.repoIndex === 1) return 'six';
  if (row.length >= 18 && analysis.repoIndex === 2) return 'full';
  if (analysis.anchorCount > 0) return 'dynamic';
  if (row.length === 6) return 'six';
  if (row.length >= 18) return 'full';
  if (allowTwoColumns && row.length >= 2) return 'two';
  return 'invalid';
}

function displayNameForType(type, rowLength) {
  if (type === 'two') return '2 列';
  if (type === 'six') return '6 列';
  if (type === 'full') return '19 列';
  if (type === 'dynamic') return `动态 ${rowLength} 列`;
  return '';
}

export function parseRawRecord(rawText, { allowTwoColumns = false } = {}) {
  const { row, delimiterName } = chooseBestRow(rawText, allowTwoColumns);
  const analysis = analyzeRow(row);
  const type = inferRecordType(row, analysis, allowTwoColumns);
  const data = type === 'invalid' ? EMPTY_RAW_RECORD : buildDynamicData(row, analysis);
  const ok = type !== 'invalid';

  return {
    ok,
    type,
    delimiterName,
    displayName: displayNameForType(type, row.length),
    row: type === 'full' ? padRow(row, Math.max(row.length, FULL_RECORD_COLUMN_COUNT)) : row,
    data,
    rubricsColumnIndex: analysis.rubricsIndex,
    scoreColumnIndex: analysis.scoreIndex,
    repoColumnIndex: analysis.repoIndex,
    errors: ok
      ? []
      : [
          allowTwoColumns
            ? `只解析到 ${row.length} 列，至少需要包含 repo、rubrics 或 prompt/repo 两列。`
            : `只解析到 ${row.length} 列，需要包含 repo、rubrics 或评分列。`,
        ],
  };
}

export function buildRawRecordTextWithCell(parseResult, cellIndex, value) {
  const row = [...(parseResult?.row || [])];
  if (!Number.isInteger(cellIndex) || cellIndex < 0) return null;
  while (row.length <= cellIndex) row.push('');
  row[cellIndex] = value;
  return row.map(escapeTsvCell).join('\t');
}

export function escapeTsvCell(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!/[\t\n"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildAiPlaceholderContext(record, overrides = {}) {
  const context = { ...(record?.variables || {}) };
  Object.keys(FIELD_LABELS).forEach((key) => {
    context[key] = record?.[key] || '';
    context[FIELD_LABELS[key]] = record?.[key] || '';
  });
  return { ...context, ...overrides };
}
