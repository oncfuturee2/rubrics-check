export const EMPTY_PARSED_ZERO_NOTE_MESSAGE = '该备注为空，可能是程序解析失败，请查看原始标注备注进行核对';

function expandNumberList(value) {
  return String(value || '')
    .replace(/和/g, '、')
    .split(/[、,，\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
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
  const rubricPattern = /第\s*([0-9、,，\s和]+)\s*(?:条|个)\s*rub(?:rics|tics)?\s*(?:->|→|:|：)?/gi;

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
