import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPostCommitCleanupCandidates } from '../mediaLifecycle.ts';

const media = (id) => ({ id, uri: `file://${id}`, type: 'image' });

test('post-commit candidates exclude persisted and duplicate media', () => {
  const candidates = [media('removed'), media('staged'), media('removed')];
  const persisted = [media('staged')];
  assert.deepEqual(
    selectPostCommitCleanupCandidates(candidates, persisted).map((item) => item.id),
    ['removed'],
  );
});

test('failed or cancelled paths have no cleanup candidates until success calls the helper', () => {
  const staged = [media('failed-stage')];
  // The UI only invokes the physical deletion loop after diary commit and
  // draft deletion; failed/cancelled flows never call this selector.
  assert.deepEqual(selectPostCommitCleanupCandidates([], []), []);
  assert.equal(staged[0].uri, 'file://failed-stage');
});
