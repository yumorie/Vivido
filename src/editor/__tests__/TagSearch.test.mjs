import assert from 'node:assert/strict';
import test from 'node:test';
import { rankTagSuggestions } from '../../utils/tagSearch.ts';

const tag = (name, usageCount = 0, lastUsedAt = null) => ({
  id: name,
  name,
  color: '#c47030',
  createdAt: 1,
  usageCount,
  lastUsedAt,
});

test('tag suggestions prioritize exact, prefix, contains, then usage and recency', () => {
  const ranked = rankTagSuggestions([
    tag('项目记录', 2, 10),
    tag('项目开发', 2, 10),
    tag('项目', 1, 1),
    tag('我的项目', 99, 99),
  ], '项目');

  assert.deepEqual(ranked.map((item) => item.name), ['项目', '项目开发', '项目记录', '我的项目']);
});

test('empty tag input uses usage and recent history without database calls', () => {
  const ranked = rankTagSuggestions([
    tag('旧标签', 10, 1),
    tag('最近标签', 1, 20),
    tag('常用标签', 10, 10),
  ], '');

  assert.deepEqual(ranked.map((item) => item.name), ['常用标签', '旧标签', '最近标签']);
});
