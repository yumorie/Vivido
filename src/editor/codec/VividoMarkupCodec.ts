/**
 * The deliberately small V1 markup boundary.
 *
 * This is not a general Markdown parser. It only understands the three
 * inline marks that Vivido persists. HTML is an editor-runtime transport
 * format and never crosses the persistence boundary.
 */

export const VIVIDO_HIGHLIGHT_COLOR = '#fff2a8';

export type VividoMediaType = 'image' | 'audio' | 'video';
export type VividoMediaBlock = {
  kind: 'media';
  mediaType: VividoMediaType;
  mediaId: string;
  alt?: string;
};
export type VividoMarkupBlock =
  | { kind: 'paragraph'; markup: string }
  | VividoMediaBlock;

const MEDIA_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

const escapeMediaAlt = (value: string): string =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll(']', '\\]')
    .replaceAll('*', '\\*')
    .replaceAll('=', '\\=');

const unescapeMediaAlt = (value: string): string => {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && index + 1 < value.length && '\\]*='.includes(value[index + 1])) {
      output += value[index + 1];
      index += 1;
    } else {
      output += value[index];
    }
  }
  return output;
};

export const isValidMediaId = (mediaId: string): boolean => MEDIA_ID_PATTERN.test(mediaId);

export const parseMediaLine = (line: string): VividoMediaBlock | null => {
  const image = line.match(/^!\[(.*)\]\(media:\/\/([A-Za-z0-9._~-]+)\)$/);
  if (image && isValidMediaId(image[2])) {
    return { kind: 'media', mediaType: 'image', mediaId: image[2], alt: unescapeMediaAlt(image[1]) };
  }

  const media = line.match(/^@\[(audio|video)\]\(media:\/\/([A-Za-z0-9._~-]+)\)$/);
  if (media && isValidMediaId(media[2])) {
    return { kind: 'media', mediaType: media[1] as 'audio' | 'video', mediaId: media[2] };
  }

  return null;
};

/**
 * Remove only the runtime label/id artifacts emitted by older media atoms.
 * The match is deliberately adjacent and exact so ordinary user text is not
 * broadly rewritten during the next canonical save.
 */
export const stripMediaRuntimeArtifacts = (markup: string): string => {
  const lines = markup.replaceAll('\r\n', '\n').split('\n');
  const cleaned: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const media = parseMediaLine(line);
    cleaned.push(line);
    if (!media) continue;

    const label = media.mediaType === 'image' ? '图片' : media.mediaType === 'audio' ? '录音' : '视频';
    if (lines[index + 1] === `${label}${media.mediaId}`) {
      index += 1;
    } else if (lines[index + 1] === label && lines[index + 2] === media.mediaId) {
      index += 2;
    }
  }
  return cleaned.join('\n');
};

export const serializeMediaBlock = (block: VividoMediaBlock): string => {
  if (block.mediaType === 'image') {
    return `![${escapeMediaAlt(block.alt ?? '')}](media://${block.mediaId})`;
  }
  return `@[${block.mediaType}](media://${block.mediaId})`;
};

export const parseMarkupDocument = (markup: string): VividoMarkupBlock[] =>
  stripMediaRuntimeArtifacts(markup).split('\n').map((line) => {
    const media = parseMediaLine(line);
    return media ? media : { kind: 'paragraph', markup: line };
  });

export const collectMediaIds = (markup: string): Set<string> =>
  new Set(
    parseMarkupDocument(markup)
      .filter((block): block is VividoMediaBlock => block.kind === 'media')
      .map((block) => block.mediaId),
  );

export const removeMediaBlock = (markup: string, mediaId: string): string =>
  parseMarkupDocument(markup)
    .filter((block) => block.kind !== 'media' || block.mediaId !== mediaId)
    .map((block) => block.kind === 'media' ? serializeMediaBlock(block) : block.markup)
    .join('\n');

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const escapeMarkupText = (value: string): string =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('*', '\\*')
    .replaceAll('=', '\\=');

export type VividoInlineRun = { text: string; bold: boolean; italic: boolean; highlight: boolean };
type MarkRun = VividoInlineRun;

type ActiveMarks = { bold: boolean; italic: boolean; highlight: boolean };

const literalMarkupText = (source: string): string =>
  source.replaceAll('\\\\', '\\').replaceAll('\\*', '*').replaceAll('\\=', '=');

export const parseInlineRuns = (source: string): VividoInlineRun[] => {
  const runs: MarkRun[] = [];
  const active: ActiveMarks = { bold: false, italic: false, highlight: false };
  let plain = '';

  const flush = () => {
    if (!plain) return;
    const previous = runs[runs.length - 1];
    if (
      previous &&
      previous.bold === active.bold &&
      previous.italic === active.italic &&
      previous.highlight === active.highlight
    ) {
      previous.text += plain;
    } else {
      runs.push({ text: plain, ...active });
    }
    plain = '';
  };

  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] === '\\') {
      if (cursor + 1 < source.length && '\\*='.includes(source[cursor + 1])) {
        plain += source[cursor + 1];
        cursor += 2;
      } else {
        plain += '\\';
        cursor += 1;
      }
      continue;
    }

    const delimiter = source.startsWith('***', cursor)
      ? '***'
      : source.startsWith('**', cursor)
        ? '**'
        : source.startsWith('==', cursor)
          ? '=='
          : source[cursor] === '*'
            ? '*'
            : null;
    if (!delimiter) {
      plain += source[cursor];
      cursor += 1;
      continue;
    }

    flush();
    if (delimiter === '***') {
      if (active.bold && active.italic) {
        active.bold = false;
        active.italic = false;
      } else if (active.bold) {
        active.bold = false;
        active.italic = true;
      } else if (active.italic) {
        active.italic = false;
        active.bold = true;
      } else {
        active.bold = true;
        active.italic = true;
      }
    } else if (delimiter === '**') {
      active.bold = !active.bold;
    } else if (delimiter === '*') {
      active.italic = !active.italic;
    } else {
      active.highlight = !active.highlight;
    }
    cursor += delimiter.length;
  }

  if (active.bold || active.italic || active.highlight) {
    return [{ text: literalMarkupText(source), bold: false, italic: false, highlight: false }];
  }
  flush();
  return runs;
};

const inlineRunsToHtml = (runs: MarkRun[]): string => runs.map((run) => {
  let value = escapeHtml(run.text);
  if (run.highlight) value = `<mark data-color="${VIVIDO_HIGHLIGHT_COLOR}">${value}</mark>`;
  if (run.italic) value = `<em>${value}</em>`;
  if (run.bold) value = `<strong>${value}</strong>`;
  return value;
}).join('');

export const markupToHtml = (markup: string): string => {
  return parseMarkupDocument(markup).map((block) => {
    if (block.kind === 'media') {
      const alt = block.mediaType === 'image' ? ` data-vivido-media-alt="${escapeHtml(block.alt ?? '')}"` : '';
      return `<div data-vivido-media-type="${block.mediaType}" data-vivido-media-id="${block.mediaId}"${alt}></div>`;
    }
    return `<p>${inlineRunsToHtml(parseInlineRuns(block.markup))}</p>`;
  }).join('');
};

const decodeHtml = (value: string): string =>
  value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const MARK_ORDER: Array<keyof Omit<MarkRun, 'text'>> = ['bold', 'italic', 'highlight'];
const MARK_DELIMITER: Record<keyof Omit<MarkRun, 'text'>, string> = {
  bold: '**',
  italic: '*',
  highlight: '==',
};

const serializeRuns = (runs: MarkRun[]): string => {
  let output = '';
  let active: Array<keyof Omit<MarkRun, 'text'>> = [];

  for (const run of runs.filter((candidate) => candidate.text.length > 0)) {
    const next = MARK_ORDER.filter((mark) => run[mark]);
    let shared = 0;
    while (shared < active.length && shared < next.length && active[shared] === next[shared]) {
      shared += 1;
    }
    for (let index = active.length - 1; index >= shared; index -= 1) {
      output += MARK_DELIMITER[active[index]];
    }
    for (let index = shared; index < next.length; index += 1) {
      output += MARK_DELIMITER[next[index]];
    }
    output += escapeMarkupText(run.text);
    active = next;
  }

  for (let index = active.length - 1; index >= 0; index -= 1) {
    output += MARK_DELIMITER[active[index]];
  }
  return output;
};

/** Convert the transient HTML returned by TenTap to canonical Vivido markup. */
export const htmlToMarkup = (html: string): string => {
  const paragraphs: string[] = [];
  let runs: MarkRun[] = [];
  const markStack: string[] = [];
  let paragraphOpen = false;

  const appendText = (value: string) => {
    if (!value) return;
    const mark = {
      text: decodeHtml(value),
      bold: markStack.includes('bold'),
      italic: markStack.includes('italic'),
      highlight: markStack.includes('highlight'),
    };
    const previous = runs[runs.length - 1];
    if (
      previous &&
      previous.bold === mark.bold &&
      previous.italic === mark.italic &&
      previous.highlight === mark.highlight
    ) {
      previous.text += mark.text;
    } else {
      runs.push(mark);
    }
  };

  const closeParagraph = () => {
    paragraphs.push(serializeRuns(runs));
    runs = [];
    paragraphOpen = false;
  };

  const tokens = html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      paragraphOpen = true;
      appendText(token);
      continue;
    }

    const tagMatch = token.match(/^<\/?\s*([a-z0-9]+)([^>]*)>/i);
    if (!tagMatch) continue;
    const closing = /^<\//.test(token);
    const tag = tagMatch[1].toLowerCase();
    if (!closing && tag === 'div') {
      const type = token.match(/data-vivido-media-type=["'](image|audio|video)["']/i)?.[1]?.toLowerCase() as VividoMediaType | undefined;
      const mediaId = token.match(/data-vivido-media-id=["']([A-Za-z0-9._~-]+)["']/i)?.[1];
      if (type && mediaId && isValidMediaId(mediaId)) {
        if (paragraphOpen) closeParagraph();
        const alt = token.match(/data-vivido-media-alt=["']([^"']*)["']/i)?.[1] ?? '';
        paragraphs.push(serializeMediaBlock({ kind: 'media', mediaType: type, mediaId, alt: decodeHtml(alt) }));
        paragraphOpen = false;
        continue;
      }
    }
    if (closing && tag === 'div' && !paragraphOpen && paragraphs.length > 0 && parseMediaLine(paragraphs[paragraphs.length - 1])) {
      continue;
    }
    if (!closing && (tag === 'p' || tag === 'div')) {
      if (paragraphOpen) closeParagraph();
      paragraphOpen = true;
      continue;
    }
    if (closing && (tag === 'p' || tag === 'div')) {
      if (paragraphOpen) closeParagraph();
      else paragraphs.push('');
      continue;
    }
    if (!closing && tag === 'br') {
      paragraphOpen = true;
      appendText('\n');
      continue;
    }
    if (!closing && (tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i' || tag === 'mark')) {
      markStack.push(tag === 'strong' || tag === 'b' ? 'bold' : tag === 'em' || tag === 'i' ? 'italic' : 'highlight');
      continue;
    }
    if (closing && (tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i' || tag === 'mark')) {
      const mark = tag === 'strong' || tag === 'b' ? 'bold' : tag === 'em' || tag === 'i' ? 'italic' : 'highlight';
      const index = markStack.lastIndexOf(mark);
      if (index >= 0) markStack.splice(index, 1);
    }
  }

  if (paragraphOpen) closeParagraph();
  if (paragraphs.length === 0) paragraphs.push('');
  return stripMediaRuntimeArtifacts(paragraphs.join('\n'));
};

export const canonicalizeMarkup = (markup: string): string => htmlToMarkup(markupToHtml(markup));

/** Plain-text summary used for lightweight counters; it never touches the editor. */
export const extractPlainText = (markup: string): string =>
  parseMarkupDocument(markup)
    .filter((block): block is { kind: 'paragraph'; markup: string } => block.kind === 'paragraph')
    .map((block) => parseInlineRuns(block.markup).map((run) => run.text).join(''))
    .join('\n');
