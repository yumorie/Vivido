import React, { useMemo } from 'react';
import { Image } from 'expo-image';
import { Text, StyleSheet, TouchableOpacity, View } from 'react-native';
import type { MediaItem } from '../types';
import {
  parseInlineRuns,
  parseMarkupDocument,
  VIVIDO_HIGHLIGHT_COLOR,
  type VividoMediaBlock,
} from '../editor';
import { AudioPlayer } from './AudioPlayer';
import { VideoPoster } from './VideoPoster';
import { colors, typography } from '../theme';

interface Props {
  markup: string;
  media: MediaItem[];
  onPressMedia?: (media: MediaItem) => void;
}

const VividoMediaPlaceholder = ({ block }: { block: VividoMediaBlock }) => (
  <View style={styles.missingMedia}>
    <Text style={styles.missingMediaTitle}>{block.mediaType}</Text>
    <Text style={styles.missingMediaText}>媒体暂不可用</Text>
  </View>
);

export const VividoMarkupContent: React.FC<Props> = ({ markup, media, onPressMedia }) => {
  const blocks = useMemo(() => parseMarkupDocument(markup), [markup]);
  const mediaById = useMemo(() => new Map(media.map((item) => [item.id, item])), [media]);

  return (
    <View style={styles.container}>
      {blocks.map((block, index) => {
        if (block.kind === 'paragraph') {
          const runs = parseInlineRuns(block.markup);
          return (
            <Text key={`paragraph-${index}`} style={styles.paragraph}>
              {runs.map((run, runIndex) => (
                <Text
                  key={`run-${runIndex}`}
                  style={[
                    run.bold && styles.bold,
                    run.italic && styles.italic,
                    run.highlight && styles.highlight,
                  ]}
                >
                  {run.text || ' '}
                </Text>
              ))}
            </Text>
          );
        }

        const item = mediaById.get(block.mediaId);
        if (!item || item.type !== block.mediaType) {
          return <VividoMediaPlaceholder key={`media-${index}`} block={block} />;
        }

        if (item.type === 'audio') {
          return <AudioPlayer key={`media-${index}`} uri={item.uri} />;
        }

        const visual = item.type === 'image' ? (
          <Image source={{ uri: item.uri }} style={styles.image} contentFit="contain" />
        ) : (
          <VideoPoster
            thumbnailUri={item.thumbnail}
            style={styles.video}
            label="视频"
          />
        );

        return (
          <TouchableOpacity
            key={`media-${index}`}
            activeOpacity={0.9}
            disabled={!onPressMedia}
            onPress={() => onPressMedia?.(item)}
            style={styles.mediaFrame}
          >
            {visual}
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { width: '100%' },
  paragraph: {
    ...typography.body,
    fontSize: 17,
    color: colors.text,
    lineHeight: 32,
    marginBottom: 16,
  },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  highlight: { backgroundColor: VIVIDO_HIGHLIGHT_COLOR },
  mediaFrame: {
    width: '100%',
    minHeight: 180,
    marginBottom: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  image: { width: '100%', height: 240 },
  video: { width: '100%', height: 240 },
  missingMedia: {
    minHeight: 64,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  missingMediaTitle: { ...typography.body, color: colors.text, fontWeight: '600' },
  missingMediaText: { ...typography.body, fontSize: 12, color: colors.textSecondary, marginTop: 4 },
});
