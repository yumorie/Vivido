import type { MediaItem } from '../types';

/** Candidates eligible for the post-commit reference check only. */
export const selectPostCommitCleanupCandidates = (
  candidates: MediaItem[],
  persistedMedia: MediaItem[],
): MediaItem[] => {
  const persistedIds = new Set(persistedMedia.map((item) => item.id));
  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (persistedIds.has(item.id) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
};
