import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeMarkup,
  collectMediaIds,
  extractPlainText,
  htmlToMarkup,
  markupToHtml,
  parseMediaLine,
  parseMarkupDocument,
} from '../codec/VividoMarkupCodec.ts';

test('canonicalizes V1 marks and remains stable after reload', () => {
  const samples = [
    '这是 **粗体中文** 文本。',
    '这是 *斜体中文* 文本。',
    '这是 ==高亮中文== 文本。',
    '**粗体和 ==高亮== 的组合**',
    '*斜体和 ==高亮== 的组合*',
    '***粗体和斜体以及 ==高亮==***',
    '中文、emoji 😀、English 123\n\n空段落之后',
  ];

  for (const sample of samples) {
    const first = canonicalizeMarkup(sample);
    const second = canonicalizeMarkup(first);
    assert.equal(second, first, sample);
    assert.equal(htmlToMarkup(markupToHtml(first)), first, sample);
  }
  assert.equal(canonicalizeMarkup('**粗体和 ==高亮== 的组合**'), '**粗体和 ==高亮== 的组合**');
  assert.equal(canonicalizeMarkup('*斜体和 ==高亮== 的组合*'), '*斜体和 ==高亮== 的组合*');
  assert.equal(canonicalizeMarkup('***粗体和斜体以及 ==高亮==***'), '***粗体和斜体以及 ==高亮==***');
});

test('literal backslashes do not drift across canonical saves', () => {
  const source = '路径 C:\\Users\\测试';
  const first = canonicalizeMarkup(source);
  assert.equal(first, '路径 C:\\\\Users\\\\测试');
  assert.equal(canonicalizeMarkup(first), first);
});

test('partial overlapping mark runs preserve exact HTML semantics', () => {
  const htmlSamples = [
    '<p><strong>粗体</strong><strong><em>粗斜</em></strong></p>',
    '<p><em>斜体</em><strong><em>粗斜</em></strong></p>',
    '<p><strong>粗体</strong><strong><em>粗斜</em></strong><strong><em><mark>粗斜高亮</mark></em></strong></p>',
    '<p><strong>粗体</strong><em>斜体</em><strong><em>相邻粗斜</em></strong></p>',
    '<p><strong><em>整段粗斜</em></strong></p>',
  ];
  for (const html of htmlSamples) {
    const markup = htmlToMarkup(html);
    assert.equal(htmlToMarkup(markupToHtml(markup)), markup);
  }
});

test('plain-text extraction does not serialize editor content', () => {
  assert.equal(extractPlainText('**中文** ==高亮==\n*第二段*'), '中文 高亮\n第二段');
});

test('unknown and unclosed syntax is safe text', () => {
  const malformed = '未闭合 *斜体、==高亮、@[unknown](media://id)';
  const canonical = canonicalizeMarkup(malformed);
  assert.match(canonical, /未闭合/);
  assert.match(canonical, /unknown/);
  assert.equal(canonicalizeMarkup(canonical), canonical);
  assert.doesNotThrow(() => htmlToMarkup('<p><mark><strong>中文</strong></mark></p><p></p>'));
});

test('media blocks round-trip in order and stay out of plain text', () => {
  const sample = [
    '文本 A',
    '![测试图片](media://image-test-1)',
    '文本 B',
    '@[audio](media://audio-test-1)',
    '文本 C',
    '@[video](media://video-test-1)',
    '文本 D',
  ].join('\n');

  assert.equal(canonicalizeMarkup(sample), sample);
  assert.equal(htmlToMarkup(markupToHtml(sample)), sample);
  assert.deepEqual([...collectMediaIds(sample)], [
    'image-test-1',
    'audio-test-1',
    'video-test-1',
  ]);
  assert.equal(extractPlainText(sample), '文本 A\n文本 B\n文本 C\n文本 D');
  assert.equal(parseMarkupDocument('before ![x](media://image-test-1) after')[0].kind, 'paragraph');
});

/* Superseded by the parser-focused alt test below.
test.skip('image alt text is escaped and remains canonical across HTML reloads (superseded by parser test)', () => {
  const sample = '![中文 & "引号" \\ 路径 \\]\\*\\=](media://image-test-1)';
  const canonical = canonicalizeMarkup(sample);

  assert.equal(canonicalizeMarkup(canonical), canonical);
  assert.equal(htmlToMarkup(markupToHtml(canonical)), canonical);
  assert.equal(canonical, '![中文 & "引号" \\\\ 路径 \\\\]\\*\\=](media://image-test-1)');
}); */

test('image alt parser restores escaped special characters', () => {
  const alt = 'alt & "quotes" \\ path ] * =';
  const source = `![${alt}](media://image-test-1)`;
  const canonical = canonicalizeMarkup(source);

  assert.equal(parseMediaLine(canonical)?.alt, alt);
  assert.equal(htmlToMarkup(markupToHtml(canonical)), canonical);
  assert.equal(canonicalizeMarkup(canonical), canonical);
});

test('malformed or unsupported media syntax stays ordinary text', () => {
  const malformed = [
    '![空](media://)',
    '@[unknown](media://image-test-1)',
    '@[audio](media://bad/id)',
    '前文 @[video](media://video-test-1) 后文',
  ].join('\n');

  assert.equal(parseMarkupDocument(malformed).every((block) => block.kind === 'paragraph'), true);
  assert.equal(canonicalizeMarkup(malformed), malformed);
});
