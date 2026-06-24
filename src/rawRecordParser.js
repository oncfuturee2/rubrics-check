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

const STANDARD_COLUMNS = [
  ['prompt', 'prompt'],
  ['repo', 'repo'],
  ['taskType', '任务类型'],
  ['rubrics', 'rubrics'],
  ['score', '评分'],
  ['note', '备注'],
];

const FULL_COLUMNS = [
  ['uid', 'uid'],
  ['prompt', 'prompt'],
  ['repo', 'repo'],
  ['taskType', '任务类型'],
  ['rubrics', 'rubrics'],
  ['score', '评分'],
  ['note', '备注'],
  ['annotator', '标注人'],
  ['date', '日期'],
  ['rescan', '回扫'],
  ['supplier', '供应商'],
  ['deliveryBatch', '交付批次'],
  ['internalQc', '内部质检'],
  ['qcPerson', '质检人'],
  ['qcComment', '质检备注'],
  ['internalSample', '内部抽检'],
  ['samplePerson', '抽检人'],
  ['sampleComment', '抽检备注'],
  ['sampleDate', '抽检日期'],
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
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch (error) {
    // Fall back to loose URL extraction.
  }

  return value.match(/https?:\/\/[^\s,"'\]\)]+/g) || [];
}

function padRow(row, length) {
  const next = [...row];
  while (next.length < length) next.push('');
  return next;
}

function mapColumns(row, columns) {
  const variables = {};
  columns.forEach(([key, label], index) => {
    const value = row[index] || '';
    variables[key] = value;
    if (!variables[label]) variables[label] = value;
  });
  return variables;
}

function buildStandardData(row) {
  const cells = padRow(row, 6);
  return {
    ...EMPTY_RAW_RECORD,
    prompt: cells[0] || '',
    repo: cells[1] || '',
    taskType: cells[2] || '',
    rubrics: cells[3] || '',
    score: cells[4] || '',
    note: cells.slice(5).join('\n') || '',
    variables: mapColumns([cells[0], cells[1], cells[2], cells[3], cells[4], cells.slice(5).join('\n')], STANDARD_COLUMNS),
  };
}

function buildTwoColumnData(row) {
  const cells = padRow(row, 2);
  return {
    ...EMPTY_RAW_RECORD,
    prompt: cells[0] || '',
    repo: cells[1] || '',
    variables: mapColumns(cells, STANDARD_COLUMNS.slice(0, 2)),
  };
}

function buildFullData(row) {
  const cells = padRow(row, FULL_RECORD_COLUMN_COUNT);
  const variables = mapColumns(cells, FULL_COLUMNS);
  return {
    ...EMPTY_RAW_RECORD,
    uid: cells[0] || '',
    prompt: cells[1] || '',
    repo: cells[2] || '',
    taskType: cells[3] || '',
    rubrics: cells[4] || '',
    score: cells[5] || '',
    note: cells[6] || '',
    annotator: cells[7] || '',
    date: cells[8] || '',
    rescan: cells[9] || '',
    supplier: cells[10] || '',
    deliveryBatch: cells[11] || '',
    internalQc: cells[12] || '',
    qcPerson: cells[13] || '',
    qcComment: cells[14] || '',
    internalSample: cells[15] || '',
    samplePerson: cells[16] || '',
    sampleComment: cells[17] || '',
    sampleDate: cells[18] || '',
    variables,
  };
}

function inferRecordKind(row, allowTwoColumns) {
  if (row.length >= 18 || (row.length >= 7 && parseRepoLikeList(row[2]).length)) return 'full';
  if (row.length >= 6) return 'six';
  if (allowTwoColumns && row.length >= 2) return 'two';
  return 'invalid';
}

function parseRow(rawText, delimiter) {
  const clean = stripCodeFence(rawText);
  return pickDataRow(parseDelimitedRows(clean, delimiter));
}

export function parseRawRecord(rawText, { allowTwoColumns = false } = {}) {
  const tabRow = parseRow(rawText, '\t');
  let row = tabRow;
  let delimiterName = 'Tab';

  if (row.length < (allowTwoColumns ? 2 : 6)) {
    const pipeRow = parseRow(rawText, '|');
    if (pipeRow.length >= row.length) {
      row = pipeRow;
      delimiterName = '竖线';
    }
  }

  const type = inferRecordKind(row, allowTwoColumns);

  if (type === 'full') {
    const data = buildFullData(row);
    return {
      ok: true,
      type,
      delimiterName,
      displayName: '19 列',
      row: padRow(row, FULL_RECORD_COLUMN_COUNT),
      data,
      rubricsColumnIndex: 4,
      errors: [],
    };
  }

  if (type === 'six') {
    const data = buildStandardData(row);
    const isExactSix = row.length === 6;
    return {
      ok: isExactSix,
      type,
      delimiterName,
      displayName: '6 列',
      row,
      data,
      rubricsColumnIndex: 3,
      errors: isExactSix
        ? []
        : [`解析到 ${row.length} 列，当前仅支持 6 列或 19 列原始数据。`],
    };
  }

  if (type === 'two') {
    return {
      ok: true,
      type,
      delimiterName,
      displayName: '2 列',
      row,
      data: buildTwoColumnData(row),
      rubricsColumnIndex: null,
      errors: [],
    };
  }

  return {
    ok: false,
    type,
    delimiterName,
    displayName: '',
    row,
    data: EMPTY_RAW_RECORD,
    rubricsColumnIndex: null,
    errors: [
      allowTwoColumns
        ? `只解析到 ${row.length} 列，至少需要 prompt 和 repo 两列。`
        : `只解析到 ${row.length} 列，需要 6 列或 19 列原始数据。`,
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
  return {
    ...(record?.variables || {}),
    uid: record?.uid || '',
    prompt: record?.prompt || '',
    repo: record?.repo || '',
    taskType: record?.taskType || '',
    rubrics: record?.rubrics || '',
    score: record?.score || '',
    note: record?.note || '',
    qcComment: record?.qcComment || '',
    ...overrides,
  };
}
