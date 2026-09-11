import type { Tag } from '../types';

export type TagSuggestion = Tag & {
  usageCount: number;
  lastUsedAt: number | null;
};

const matchRank = (name: string, query: string): number => {
  if (!query) return 3;
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return 4;
};

/** Sort local tag suggestions without touching SQLite while the user types. */
export const rankTagSuggestions = (
  tags: TagSuggestion[],
  input: string,
): TagSuggestion[] => {
  const query = input.trim().toLocaleLowerCase();
  return tags
    .filter((tag) => !query || tag.name.toLocaleLowerCase().includes(query))
    .slice()
    .sort((left, right) => {
      const rankDifference = matchRank(left.name.toLocaleLowerCase(), query)
        - matchRank(right.name.toLocaleLowerCase(), query);
      if (rankDifference !== 0) return rankDifference;

      const usageDifference = right.usageCount - left.usageCount;
      if (usageDifference !== 0) return usageDifference;

      const recentDifference = (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0);
      if (recentDifference !== 0) return recentDifference;

      if (left.name !== right.name) return left.name < right.name ? -1 : 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
};
