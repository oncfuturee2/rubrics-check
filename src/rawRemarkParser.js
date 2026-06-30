export const EMPTY_PARSED_ZERO_NOTE_MESSAGE = '该备注为空，可能是程序解析失败，请查看原始标注备注进行核对';

function expandNumberList(value) {
  const numbers = [];
  const seen = new Set();
  const numberTextPattern = '[0-9零一二两三四五六七八九十]+';
  const rangePattern = new RegExp(`^(${numberTextPattern})\\s*(?:-|~|至|到)\\s*(${numberTextPattern})$`);

  function pushNumber(number) {
    if (!Number.isInteger(number) || number <= 0 || seen.has(number)) return;
    seen.add(number);
    numbers.push(number);
  }

  String(value || '')
    .replace(/[－–—～]/g, (match) => (match === '～' ? '~' : '-'))
    .replace(/([0-9零一二两三四五六七八九十]+)\s*([-~至到])\s*([0-9零一二两三四五六七八九十]+)/g, '$1$2$3')
    .replace(/[和及与]/g, '、')
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const rangeMatch = item.match(rangePattern);
      if (rangeMatch) {
        const start = parseChineseNumber(rangeMatch[1]);
        const end = parseChineseNumber(rangeMatch[2]);
        if (Number.isInteger(start) && Number.isInteger(end) && start <= end) {
          for (let number = start; number <= end; number += 1) pushNumber(number);
          return;
        }
      }
      pushNumber(parseChineseNumber(item));
    });

  return numbers;
}

function parseChineseNumber(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const digits = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (digits[text[1]] || 0);
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    return (digits[tens] || 0) * 10 + (digits[ones] || 0);
  }
  return digits[text] || null;
}

function cleanDescription(value) {
  return String(value || '')
    .replace(/^\s*(?:->|→|:|：)\s*/, '')
    .replace(/^[；;,，。\s]+/, '')
    .replace(/\s*\n\s*\d+\s*[.、)]\s*$/, '')
    .replace(/[；;,，。\s]+$/, '')
    .trim();
}

function getRemarkTokens(noteText) {
  const text = String(noteText || '').replace(/\r\n/g, '\n');
  const tokens = [];
  const pagePattern = /第\s*([0-9零一二两三四五六七八九十]+)\s*个\s*页面\s*(?:->|→|:|：)?/g;
  const rubricPattern = /第\s*([0-9零一二两三四五六七八九十、,，\s和及与\-－–—~～至到]+)\s*(?:条|个)\s*rub(?:rics|tics)?\s*(?:->|→|:|：)?/gi;

  for (const match of text.matchAll(pagePattern)) {
    tokens.push({
      type: 'page',
      index: match.index,
      end: match.index + match[0].length,
      pageNumber: parseChineseNumber(match[1]),
    });
  }

  for (const match of text.matchAll(rubricPattern)) {
    tokens.push({
      type: 'rubric',
      index: match.index,
      end: match.index + match[0].length,
      rubricNumbers: expandNumberList(match[1]),
    });
  }

  return tokens.sort((left, right) => left.index - right.index || (left.type === 'page' ? -1 : 1));
}

function getStrictRemarkTokens(noteText) {
  const text = String(noteText || '').replace(/\r\n/g, '\n');
  const tokens = [];
  const pagePattern = /(^|[;；。\n\r])\s*(?:\d+[.、)]\s*)?第([1-9]\d*)个页面->/g;
  const rubricPattern = /第([1-9]\d*(?:(?:[、,，]|-|~|至|到)[1-9]\d*)*)条rubrics->/gi;

  for (const match of text.matchAll(pagePattern)) {
    const tokenIndex = match.index + match[1].length;
    tokens.push({
      type: 'page',
      index: tokenIndex,
      end: match.index + match[0].length,
      pageNumber: Number(match[2]),
    });
  }

  for (const match of text.matchAll(rubricPattern)) {
    tokens.push({
      type: 'rubric',
      index: match.index,
      end: match.index + match[0].length,
      rubricNumbers: expandNumberList(match[1]),
    });
  }

  return tokens.sort((left, right) => left.index - right.index || (left.type === 'page' ? -1 : 1));
}

function isOnlySafeSeparator(value) {
  return /^[\s;；,，。]*$/.test(String(value || ''));
}

function parseStrictRemark(noteText) {
  const text = String(noteText || '').replace(/\r\n/g, '\n');
  const trimmed = text.trim();
  const issueMap = new Map();
  const pageChunks = new Map();
  const tokens = getStrictRemarkTokens(text);

  if (!trimmed) return { ok: true, issueMap, pageChunks };
  if (!tokens.length || tokens[0].type !== 'page' || !isOnlySafeSeparator(text.slice(0, tokens[0].index))) {
    return { ok: false, issueMap, pageChunks };
  }

  let currentPageIndex = null;
  const pageTokens = tokens.filter((token) => token.type === 'page');
  pageTokens.forEach((token, index) => {
    const nextPage = pageTokens[index + 1];
    pageChunks.set(token.pageNumber - 1, text.slice(token.index, nextPage ? nextPage.index : text.length).trim());
  });

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const nextToken = tokens[tokenIndex + 1];
    const nextIndex = nextToken ? nextToken.index : text.length;
    const segment = text.slice(token.end, nextIndex);

    if (token.type === 'page') {
      currentPageIndex = token.pageNumber - 1;
      if (currentPageIndex < 0 || !nextToken || nextToken.type !== 'rubric' || !isOnlySafeSeparator(segment)) {
        return { ok: false, issueMap, pageChunks };
      }
      continue;
    }

    if (token.type !== 'rubric' || currentPageIndex === null || currentPageIndex < 0 || !token.rubricNumbers.length) {
      return { ok: false, issueMap, pageChunks };
    }

    const description = cleanDescription(segment);
    if (!description) return { ok: false, issueMap, pageChunks };

    token.rubricNumbers.forEach((rubricNumber) => {
      issueMap.set(`${currentPageIndex}:${rubricNumber - 1}`, description);
    });
  }

  return { ok: issueMap.size > 0, issueMap, pageChunks };
}

export function parseStrictRemarkIssues(noteText) {
  return parseStrictRemark(noteText);
}

export function parseRemarkIssues(noteText) {
  const text = String(noteText || '').replace(/\r\n/g, '\n');
  const issueMap = new Map();
  const tokens = getRemarkTokens(text);
  let currentPageIndex = null;

  tokens.forEach((token, tokenIndex) => {
    if (token.type === 'page') {
      currentPageIndex = token.pageNumber - 1;
      return;
    }

    if (token.type !== 'rubric' || currentPageIndex === null || currentPageIndex < 0) return;

    const nextToken = tokens[tokenIndex + 1];
    const description = cleanDescription(text.slice(token.end, nextToken ? nextToken.index : text.length));
    if (!description) return;

    token.rubricNumbers.forEach((rubricNumber) => {
      issueMap.set(`${currentPageIndex}:${rubricNumber - 1}`, description);
    });
  });

  return issueMap;
}

export function extractPageRemarkText(noteText, pageIndex) {
  const text = String(noteText || '').replace(/\r\n/g, '\n');
  const pageTokens = getRemarkTokens(text).filter((token) => token.type === 'page');
  return pageTokens
    .flatMap((token, index) => {
      if (token.pageNumber - 1 !== pageIndex) return [];
      const nextPage = pageTokens[index + 1];
      const chunk = text
        .slice(token.index, nextPage ? nextPage.index : text.length)
        .replace(/\s*\n\s*\d+\s*[.、)]\s*$/, '')
        .trim();
      return chunk ? [chunk] : [];
    })
    .join('\n');
}

export function extractStrictPageRemarkText(noteText, pageIndex) {
  const result = parseStrictRemark(noteText);
  if (!result.ok) return '';
  return result.pageChunks.get(pageIndex) || '';
}

export function buildRemarkTree(noteText) {
  const text = String(noteText || '').replace(/\r\n/g, '\n');
  const issueMap = parseRemarkIssues(text);
  const pageMap = new Map();

  issueMap.forEach((description, key) => {
    const [pageIndexText, rubricIndexText] = key.split(':');
    const pageNumber = Number(pageIndexText) + 1;
    const rubricNumber = Number(rubricIndexText) + 1;
    if (!Number.isInteger(pageNumber) || !Number.isInteger(rubricNumber)) return;
    if (!pageMap.has(pageNumber)) pageMap.set(pageNumber, []);
    pageMap.get(pageNumber).push({ rubricNumber, description });
  });

  return [...pageMap.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pageNumber, issues]) => ({
      pageNumber,
      issues: issues.sort((left, right) => left.rubricNumber - right.rubricNumber),
    }));
}

export function formatRemarkTree(noteText) {
  return buildRemarkTree(noteText)
    .map(({ pageNumber, issues }) => {
      const issueLines = issues
        .map((issue) => `  └ 第${issue.rubricNumber}条rubrics：${issue.description}`);
      return [`第${pageNumber}个页面`, ...issueLines].join('\n');
    })
    .join('\n\n');
}
