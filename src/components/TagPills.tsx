import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import type { Tag } from '../types';
import { alpha, colors, typography } from '../theme';

interface TagPillsProps {
  tags: Tag[];
  maxVisible?: number;
}

export const TagPills: React.FC<TagPillsProps> = ({ tags, maxVisible = 4 }) => {
  if (tags.length === 0) return null;

  const visible = tags.slice(0, maxVisible);
  const remaining = Math.max(0, tags.length - visible.length);

  return (
    <View style={styles.row}>
      {visible.map((tag) => (
        <View key={tag.id} style={styles.pill}>
          <View style={[styles.dot, { backgroundColor: tag.color }]} />
          <Text style={styles.text} numberOfLines={1}>{tag.name}</Text>
        </View>
      ))}
      {remaining > 0 && (
        <View style={styles.morePill}>
          <Text style={styles.moreText}>+{remaining}</Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: 180,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: alpha(colors.primary, 0.08),
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  text: {
    ...typography.body,
    fontSize: 12,
    color: colors.textSecondary,
  },
  morePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: alpha(colors.textSecondary, 0.1),
  },
  moreText: {
    ...typography.body,
    fontSize: 12,
    color: colors.textSecondary,
  },
});
