import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BoldBridge,
  CoreBridge,
  HardBreakBridge,
  HighlightBridge,
  HistoryBridge,
  ItalicBridge,
  RichText,
  useBridgeState,
  useEditorBridge,
} from '@10play/tentap-editor';
import type { EditorBridge } from '@10play/tentap-editor';
import type { RichEditorAdapter } from './RichEditorAdapter';
import { createRichEditorAdapter, updateRichEditorActiveState } from './RichEditorAdapter';
import { VIVIDO_HIGHLIGHT_COLOR } from './codec/VividoMarkupCodec';
import { alpha, colors, typography } from '../theme';
import { VividoMediaBridge } from './integration/VividoMediaBridge';
import type { VividoMediaEditorInstance } from './integration/VividoMediaBridge';
import { VIVIDO_MEDIA_EDITOR_SOURCE } from './integration/generated/VividoMediaEditorSource';

export interface RichEditorHostProps {
  initialMarkup: string;
  onReady?: (adapter: RichEditorAdapter) => void;
  onDirty?: () => void;
}

export const RichEditorHost = forwardRef<RichEditorAdapter, RichEditorHostProps>(
  function RichEditorHost({ initialMarkup, onReady, onDirty }, ref) {
    const onDirtyRef = useRef(onDirty);
    onDirtyRef.current = onDirty;
    const controlledLoadGenerationRef = useRef<number | null>(null);
    const onChange = useCallback(() => {
      if (controlledLoadGenerationRef.current !== null) {
        return;
      }
      onDirtyRef.current?.();
    }, []);
    const bridgeExtensions = useMemo(
      () => [CoreBridge, BoldBridge, ItalicBridge, HighlightBridge, HistoryBridge, HardBreakBridge, VividoMediaBridge],
      [],
    );
    const editor = useEditorBridge({
      autofocus: true,
      avoidIosKeyboard: true,
      initialContent: '<p></p>',
      bridgeExtensions,
      customSource: VIVIDO_MEDIA_EDITOR_SOURCE,
      onChange,
    });
    const editorState = useBridgeState(editor);
    const editorStateRef = useRef(editorState);
    editorStateRef.current = editorState;
    const editorRef = useRef<EditorBridge & VividoMediaEditorInstance>(
      editor as EditorBridge & VividoMediaEditorInstance,
    );
    editorRef.current = editor as EditorBridge & VividoMediaEditorInstance;
    const adapterRef = useRef<RichEditorAdapter | null>(null);
    if (!adapterRef.current) {
      adapterRef.current = createRichEditorAdapter(() => editorRef.current);
    }
    const adapter = adapterRef.current;
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    const loadGenerationRef = useRef(0);
    const requestedMarkupRef = useRef<string | null>(null);
    const confirmedMarkupRef = useRef<string | null>(null);
    const confirmedReadyRef = useRef(false);
    const mountedRef = useRef(true);

    useEffect(() => () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      controlledLoadGenerationRef.current = null;
      confirmedReadyRef.current = false;
    }, []);

    useImperativeHandle(ref, () => adapter, [adapter]);

    useEffect(() => {
      updateRichEditorActiveState(adapter, {
        isReady:
          Boolean(editorState.isReady) &&
          confirmedReadyRef.current &&
          confirmedMarkupRef.current === initialMarkup,
        isBoldActive: Boolean(editorState.isBoldActive),
        isItalicActive: Boolean(editorState.isItalicActive),
        isHighlightActive: Boolean(editorState.activeHighlight),
        isFocused: Boolean(editorState.isFocused),
        canUndo: Boolean(editorState.canUndo),
        canRedo: Boolean(editorState.canRedo),
      });
    }, [adapter, editorState, initialMarkup]);

    const loadAndConfirmMarkup = useCallback(async (markup: string) => {
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      requestedMarkupRef.current = markup;
      controlledLoadGenerationRef.current = generation;
      confirmedReadyRef.current = false;
      const currentState = editorStateRef.current;
      updateRichEditorActiveState(adapter, {
        isReady: false,
        isBoldActive: Boolean(currentState.isBoldActive),
        isItalicActive: Boolean(currentState.isItalicActive),
        isHighlightActive: Boolean(currentState.activeHighlight),
        isFocused: Boolean(currentState.isFocused),
        canUndo: Boolean(currentState.canUndo),
        canRedo: Boolean(currentState.canRedo),
      });
      adapter.load(markup);

      try {
        // TenTap queues bridge messages. Reading immediately after setContent
        // confirms that this exact controlled load has reached the editor.
        await adapter.getMarkup();
        if (
          !mountedRef.current ||
          generation !== loadGenerationRef.current ||
          requestedMarkupRef.current !== markup
        ) {
          return;
        }
        controlledLoadGenerationRef.current = null;
        confirmedMarkupRef.current = markup;
        confirmedReadyRef.current = true;
        const confirmedState = editorStateRef.current;
        updateRichEditorActiveState(adapter, {
          isReady: Boolean(confirmedState.isReady),
          isBoldActive: Boolean(confirmedState.isBoldActive),
          isItalicActive: Boolean(confirmedState.isItalicActive),
          isHighlightActive: Boolean(confirmedState.activeHighlight),
          isFocused: Boolean(confirmedState.isFocused),
          canUndo: Boolean(confirmedState.canUndo),
          canRedo: Boolean(confirmedState.canRedo),
        });
        onReadyRef.current?.(adapter);
      } catch (error) {
        if (generation === loadGenerationRef.current) {
          controlledLoadGenerationRef.current = null;
          confirmedReadyRef.current = false;
        }
        console.error('Failed to confirm editor content load:', error);
      }
    }, [adapter]);

    useEffect(() => {
      if (!editorState.isReady) return;
      if (confirmedMarkupRef.current === initialMarkup) return;
      void loadAndConfirmMarkup(initialMarkup);
    }, [adapter, editorState.isReady, initialMarkup, loadAndConfirmMarkup]);

    const button = useMemo(
      () => (label: string, onPress: () => void, active = false, disabled = false) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          disabled={disabled}
          style={[styles.button, active && styles.activeButton, disabled && styles.disabledButton]}
          onPress={onPress}
        >
          <Text style={styles.buttonText}>{label}</Text>
        </Pressable>
      ),
      [],
    );

    return (
      <View style={styles.host}>
        <View style={styles.editorFrame}>
          {/* RichText stays mounted for the complete editor session. */}
          <RichText editor={editor} style={styles.richText} />
        </View>
        <View style={styles.toolbar}>
          {button('B', () => adapter.toggleBold(), Boolean(editorState.isBoldActive))}
          {button('I', () => adapter.toggleItalic(), Boolean(editorState.isItalicActive))}
          {button(
            `Highlight ${editorState.activeHighlight === VIVIDO_HIGHLIGHT_COLOR ? '●' : '○'}`,
            () => adapter.toggleHighlight(),
            Boolean(editorState.activeHighlight),
          )}
          {button('Undo', () => adapter.undo(), false, !editorState.canUndo)}
          {button('Redo', () => adapter.redo(), false, !editorState.canRedo)}
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  host: { width: '100%' },
  editorFrame: {
    minHeight: 220,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: alpha(colors.primary, 0.12),
    overflow: 'hidden',
  },
  richText: { minHeight: 220, flex: 1 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 10 },
  button: {
    backgroundColor: alpha(colors.primary, 0.08),
    borderRadius: 8,
    borderWidth: 1,
    borderColor: alpha(colors.primary, 0.15),
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  activeButton: { backgroundColor: alpha(colors.primary, 0.24) },
  disabledButton: { opacity: 0.45 },
  buttonText: { ...typography.body, color: colors.text, fontWeight: '600' },
});
