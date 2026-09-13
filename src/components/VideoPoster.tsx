import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Image } from 'expo-image';

interface VideoPosterProps {
  thumbnailUri?: string;
  style?: StyleProp<ViewStyle>;
  label?: string;
  onAspectRatioChange?: (aspectRatio: number) => void;
}

export const VideoPoster: React.FC<VideoPosterProps> = ({
  thumbnailUri,
  style,
  label = '视频',
  onAspectRatioChange,
}) => {
  const imageSource = thumbnailUri ? { uri: thumbnailUri } : null;

  return (
    <View style={[styles.container, style]}>
      {imageSource ? (
        <Image
          source={imageSource}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          onLoad={(event) => {
            const { width, height } = event.source;
            if (width > 0 && height > 0) onAspectRatioChange?.(width / height);
          }}
        />
      ) : (
        <View style={styles.fallback}>
          <Text style={styles.fallbackTitle}>{label}</Text>
          <Text style={styles.fallbackSubtitle}>点击播放</Text>
        </View>
      )}

      <View style={styles.overlay}>
        <View style={styles.playButton}>
          <Text style={styles.playIcon}>▶</Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: '#231b16',
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#231b16',
  },
  fallbackTitle: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
  },
  fallbackSubtitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(196, 112, 48, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 8,
    elevation: 6,
  },
  playIcon: {
    color: '#fff',
    fontSize: 24,
    marginLeft: 4,
  },
});
