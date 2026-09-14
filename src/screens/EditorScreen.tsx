import React, { useCallback, useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Modal,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Keyboard,
  AppState,
  Dimensions,
  PixelRatio,
  Platform,
  ScrollView,
  StatusBar,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImageManipulatorContext, ImageRef } from 'expo-image-manipulator';
import { cacheDirectory, writeAsStringAsync, deleteAsync } from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { createVideoPlayer } from 'expo-video';
import type { SharedRefType } from 'expo';
import { DatePickerModal } from '../components/DatePickerModal';
import { RootStackParamList, DiaryEntry, MediaItem, Tag } from '../types';
import { getDiaryById, createDiary, updateDiary, saveDraft, getDraft, deleteDraft, isMediaReferenced, Draft } from '../services/database';
import { saveMedia, deleteMedia, MEDIA_DIR_PATH } from '../services/storage';
import { generateId } from '../utils/uuid';
import { MediaPicker } from '../components/MediaPicker';
import { TagEditor } from '../components/TagEditor';
import { AudioRecorder } from '../components/AudioRecorder';
import { StyledDialog } from '../components/StyledDialog';
import { assignMediaPositions, getMediaFileExtension, getOrderedMedia } from '../utils/media';
import { formatDateInputValue, getWeekDayLabel, parseDateInputValue } from '../utils/date';
import {
  collectMediaIds,
  extractPlainText,
  RichEditorAdapter,
  RichEditorHost,
  RichEditorToolbar,
  VIVIDO_EDITOR_PAPER_BG,
} from '../editor';
import type { RichEditorActiveState } from '../editor';
import { selectPostCommitCleanupCandidates } from '../editor/mediaLifecycle';

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Editor'>;
type EditorRouteProp = RouteProp<RootStackParamList, 'Editor'>;
type KeyboardPhase = 'hidden' | 'visible';
type PendingReveal = {
  kind: 'caret' | 'tag';
  top: number;
  bottom: number;
};
type KeyboardTraceEvent = { endCoordinates: { screenY: number; height: number } };
type LayoutFrame = { x: number; y: number; width: number; height: number };

// Development-only bounded diagnostic. It records no document or selection
// content; the UI remains closed until the developer explicitly opens Trace.
const KEYBOARD_TRACE_ENABLED = __DEV__;

const PAPER_BG = VIVIDO_EDITOR_PAPER_BG;
const TEXT_PRIMARY = '#3d2c1e';
const TEXT_SECONDARY = '#7a6250';
const TEXT_MUTED = '#a48a74';
const BRAND_GOLD = '#c47030';

const getDraftId = (diaryId?: string): string => diaryId || 'new';

type ReleasableNativeRef = { release?: () => void };

const releaseNativeRef = (ref: ReleasableNativeRef | null): void => {
  try {
    ref?.release?.();
  } catch (error) {
    // Release is best-effort; a failed native cleanup must not affect editing.
    console.warn('Failed to release transient video preview resource:', error);
  }
};

const deleteTransientPreview = async (uri: string): Promise<void> => {
  try {
    await deleteAsync(uri, { idempotent: true });
  } catch (error) {
    // Cache cleanup is deliberately non-fatal and never touches persisted media.
    console.warn('Failed to delete transient video preview:', error);
  }
};

/**
 * Materialize one video frame in the existing media directory. The returned
 * URI is business media metadata; the intermediate cache URI is never exposed
 * to markup and is removed after the copy completes.
 */
const createPersistentVideoThumbnail = async (item: MediaItem): Promise<MediaItem | null> => {
  if (item.thumbnail) return item;
  let player: ReturnType<typeof createVideoPlayer> | null = null;
  let thumbnail: SharedRefType<'image'> | null = null;
  let context: ImageManipulatorContext | null = null;
  let imageRef: ImageRef | null = null;
  let cacheUri: string | null = null;
  try {
    player = createVideoPlayer(item.uri);
    const thumbnails = await player.generateThumbnailsAsync([0.1], {
      maxWidth: 1200,
      maxHeight: 1200,
    });
    thumbnail = thumbnails[0] ?? null;
    if (!thumbnail) return null;

    context = ImageManipulator.manipulate(thumbnail);
    imageRef = await context.renderAsync();
    const result = await imageRef.saveAsync({
      format: SaveFormat.JPEG,
      base64: false,
      compress: 0.82,
    });
    cacheUri = result.uri;
    const stableThumbnailUri = await saveMedia(cacheUri, `${item.id}.thumb.jpg`);
    await deleteTransientPreview(cacheUri);
    cacheUri = null;
    return { ...item, thumbnail: stableThumbnailUri };
  } catch (error) {
    console.warn(`Failed to persist video thumbnail for ${item.id}:`, error);
    return null;
  } finally {
    releaseNativeRef(imageRef);
    releaseNativeRef(context);
    releaseNativeRef(thumbnail);
    releaseNativeRef(player);
    if (cacheUri) void deleteTransientPreview(cacheUri);
  }
};

export const EditorScreen: React.FC = () => {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<EditorRouteProp>();
  const insets = useSafeAreaInsets();
  const diaryId = route.params?.diaryId;
  const isEditing = !!diaryId;

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [date, setDate] = useState(formatDateInputValue(Date.now()));
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [editorActiveState, setEditorActiveState] = useState<RichEditorActiveState>({
    isReady: false,
    isBoldActive: false,
    isItalicActive: false,
    isHighlightActive: false,
    isFocused: false,
    canUndo: false,
    canRedo: false,
    caretRect: null,
  });
  const [keyboardPhase, setKeyboardPhase] = useState<KeyboardPhase>(() =>
    Keyboard.isVisible() ? 'visible' : 'hidden',
  );
  const [debugKeyboardTrace, setDebugKeyboardTrace] = useState<string | null>(null);
  const [debugKeyboardTraceVisible, setDebugKeyboardTraceVisible] = useState(false);
  const [debugKeyboardTraceTitle, setDebugKeyboardTraceTitle] = useState('VIVIDO_KEYBOARD_TRACE');
  const [debugKeyboardTraceError, setDebugKeyboardTraceError] = useState<string | null>(null);
  const [editorLoadError, setEditorLoadError] = useState<string | null>(null);
  const [editorMountKey, setEditorMountKey] = useState(0);
  const [entryLoaded, setEntryLoaded] = useState(!isEditing);
  const [contentLength, setContentLength] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [originalMedia, setOriginalMedia] = useState<MediaItem[]>([]);
  const [initialCreatedAt, setInitialCreatedAt] = useState(Date.now());

  // Dialog states
  const [notFoundDialogVisible, setNotFoundDialogVisible] = useState(false);
  const [loadErrorDialogVisible, setLoadErrorDialogVisible] = useState(false);
  const [emptyContentDialogVisible, setEmptyContentDialogVisible] = useState(false);
  const [invalidDateDialogVisible, setInvalidDateDialogVisible] = useState(false);
  const [saveErrorDialogVisible, setSaveErrorDialogVisible] = useState(false);
  const [libraryPermissionDialogVisible, setLibraryPermissionDialogVisible] = useState(false);
  const [unsavedDialogVisible, setUnsavedDialogVisible] = useState(false);
  const [draftDialogVisible, setDraftDialogVisible] = useState(false);

  // Date picker
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Audio recorder
  const [showAudioRecorder, setShowAudioRecorder] = useState(false);

  // Track unsaved changes
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const draftSaveTimer = useRef<NodeJS.Timeout | null>(null);

  // Store initial values for change detection
  const [initialTitle, setInitialTitle] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [initialDate, setInitialDate] = useState('');
  const [initialTags, setInitialTags] = useState<Tag[]>([]);

  // Draft data for restore dialog
  const [draftData, setDraftData] = useState<Draft | null>(null);
  const editorRef = useRef<RichEditorAdapter | null>(null);
  const editorDirtyRef = useRef(false);
  const autoSaveDraftRef = useRef<() => Promise<void>>(async () => undefined);
  const autoSaveInFlightRef = useRef<Promise<void> | null>(null);
  const autoSavePendingRef = useRef(false);
  const manualSaveRef = useRef(false);
  const editorMediaIdsRef = useRef<Set<string>>(new Set());
  const stagedMediaRef = useRef<MediaItem[]>([]);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const videoThumbnailTasksRef = useRef(new Map<string, Promise<MediaItem | null>>());
  const videoThumbnailQueueRef = useRef<Array<{
    item: MediaItem;
    resolve: (result: MediaItem | null) => void;
  }>>([]);
  const videoThumbnailWorkerRef = useRef(false);
  const videoThumbnailFailedRef = useRef(new Set<string>());
  // Thumbnails generated for an existing media row are staged derivatives;
  // they must never make the original video itself look newly staged.
  const generatedThumbnailDerivativesRef = useRef(new Map<string, string>());
  const originalMediaRef = useRef<MediaItem[]>([]);
  const editorInputOwnerRef = useRef<'editor' | 'other' | null>(null);
  const mountedRef = useRef(true);
  const editorScrollRef = useRef<ScrollView | null>(null);
  const editorAreaTopRef = useRef(0);
  const editorHostTopRef = useRef(0);
  const tagEditorTopRef = useRef(0);
  const tagInputBottomRef = useRef<number | null>(null);
  const tagInputFocusedRef = useRef(false);
  const caretEnsureFrameRef = useRef<number | null>(null);
  const latestCaretRectRef = useRef<RichEditorActiveState['caretRect']>(editorActiveState.caretRect);
  const scrollContentHeightRef = useRef(0);
  const pendingRevealRef = useRef<PendingReveal | null>(null);
  const manualScrollActiveRef = useRef(false);
  const suppressRevealAfterManualScrollRef = useRef(false);
  const lastCaretGeometryRef = useRef<{ top: number; bottom: number } | null>(null);
  const inputRevealRequestedRef = useRef(false);
  const explicitCaretRevealRequestedRef = useRef(false);
  const lastRevealCommandRef = useRef<{
    kind: PendingReveal['kind'];
    target: number;
    contentHeight: number;
    viewportHeight: number;
  } | null>(null);
  const scrollOffsetRef = useRef(0);
  const scrollViewportHeightRef = useRef(0);
  const keyboardToolbarHeightRef = useRef(0);
  const keyboardPhaseRef = useRef<KeyboardPhase>(Keyboard.isVisible() ? 'visible' : 'hidden');
  const keyboardBaselineHeightRef = useRef<number | null>(null);
  const keyboardCurrentHeightRef = useRef(0);
  const keyboardHiddenEvidenceRef = useRef(!Keyboard.isVisible());
  const keyboardFullHeightStableCountRef = useRef(0);
  const keyboardPositiveEvidenceRef = useRef(Keyboard.isVisible());
  const keyboardHidePendingRef = useRef(false);
  const keyboardToolbarFrameRef = useRef<number | null>(null);
  const keyboardToolbarGenerationRef = useRef(0);
  const foregroundRecoveryGenerationRef = useRef(0);
  const foregroundRecoveryActiveRef = useRef(false);
  const foregroundRecoveryKeepToolbarRef = useRef(false);
  // App backgrounding must sever retained WebView DOM focus. This intent is
  // derived only from confirmed keyboard evidence before the transition.
  const editorKeyboardReturnIntentRef = useRef(false);
  // AppState.currentState may be null during Expo/RN cold start. Unknown is
  // not evidence that this mounted editor is backgrounded.
  const lifecycleInactiveRef = useRef(false);
  const lifecycleBlurSentRef = useRef(false);
  const lifecycleBlurGenerationRef = useRef(0);
  const lifecycleBlurPendingRef = useRef(false);
  const lifecycleBlurAckRef = useRef(false);
  const resumeFocusGenerationRef = useRef(0);
  const resumeFocusSentRef = useRef(false);
  // In pan/no-repeat-didShow environments, a confirmed TenTap focus during
  // controlled resume is still positive evidence for the editor session.
  const resumeBridgeFocusEvidenceRef = useRef(false);
  const resumeFocusFrameRef = useRef<number | null>(null);
  const resumeWindowFocusFrameRef = useRef<number | null>(null);
  const resumeFocusFallbackTimerRef = useRef<NodeJS.Timeout | null>(null);
  const resumeFocusDeadlineTimerRef = useRef<NodeJS.Timeout | null>(null);
  const appStateRef = useRef(AppState.currentState ?? 'active');
  const lifecycleEventRingRef = useRef<string[]>([]);
  const lifecycleTraceStartedAtRef = useRef<number | null>(null);
  const lifecycleTraceLastElapsedRef = useRef(-1);
  const lifecycleTraceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const coldKeyboardTraceCapturedRef = useRef(false);
  const coldKeyboardTraceGenerationRef = useRef(0);
  const coldKeyboardTraceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const debugKeyboardTraceTitleRef = useRef('VIVIDO_KEYBOARD_TRACE');
  const debugKeyboardTraceVisibleRef = useRef(false);
  const editorReadyRef = useRef(editorReady);
  const editorRootRef = useRef<View | null>(null);
  const keyboardAvoidingViewRef = useRef<KeyboardAvoidingView | null>(null);
  const keyboardToolbarRef = useRef<View | null>(null);
  const editorRootFrameRef = useRef<LayoutFrame | null>(null);
  const kavFrameRef = useRef<LayoutFrame | null>(null);
  const scrollFrameRef = useRef<LayoutFrame | null>(null);
  const toolbarFrameRef = useRef<LayoutFrame | null>(null);
  const lastLoggedScrollOffsetRef = useRef(0);
  const safeAreaTopRef = useRef(insets.top);
  const safeAreaBottomRef = useRef(insets.bottom);
  const windowScreenTopRef = useRef(Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0);
  const keyboardAvoidingOffsetRef = useRef(
    Platform.OS === 'android'
      ? Math.max((StatusBar.currentHeight ?? 0) - insets.top, 0)
      : 0,
  );
  safeAreaTopRef.current = insets.top;
  safeAreaBottomRef.current = insets.bottom;
  windowScreenTopRef.current = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0;
  keyboardAvoidingOffsetRef.current = Platform.OS === 'android'
    ? Math.max((StatusBar.currentHeight ?? 0) - insets.top, 0)
    : 0;
  editorReadyRef.current = editorReady;
  latestCaretRectRef.current = editorActiveState.caretRect;

  const recordLifecycleEvent = useCallback((event: string, detail = '') => {
    if (!__DEV__ || !KEYBOARD_TRACE_ENABLED) return;
    const metricsHeight = typeof Keyboard.metrics === 'function' ? (Keyboard.metrics()?.height ?? 0) : 0;
    const startedAt = lifecycleTraceStartedAtRef.current ?? Date.now();
    const windowSize = Dimensions.get('window');
    const formatFrame = (frame: LayoutFrame | null) => frame
      ? `${Math.round(frame.x)},${Math.round(frame.y)},${Math.round(frame.width)}x${Math.round(frame.height)}`
      : 'null';
    const pending = pendingRevealRef.current;
    const caret = latestCaretRectRef.current;
    const targetTop = pending?.kind === 'caret' && caret
      ? editorAreaTopRef.current + editorHostTopRef.current + caret.top
      : pending?.top ?? null;
    const targetBottom = pending?.kind === 'caret' && caret
      ? editorAreaTopRef.current + editorHostTopRef.current + caret.bottom
      : pending?.bottom ?? null;
    const elapsed = Math.max(Date.now() - startedAt, lifecycleTraceLastElapsedRef.current);
    lifecycleTraceLastElapsedRef.current = elapsed;
    const snapshot = `+${elapsed}ms ${event}|${detail ? `${detail}|` : ''}app=${appStateRef.current}|phase=${keyboardPhaseRef.current}|owner=${editorInputOwnerRef.current ?? 'none'}|intent=${editorKeyboardReturnIntentRef.current ? 1 : 0}|positive=${keyboardPositiveEvidenceRef.current ? 1 : 0}|hidePending=${keyboardHidePendingRef.current ? 1 : 0}|inactive=${lifecycleInactiveRef.current ? 1 : 0}|blurPending=${lifecycleBlurPendingRef.current ? 1 : 0}|blurAck=${lifecycleBlurAckRef.current ? 1 : 0}|resumeSent=${resumeFocusSentRef.current ? 1 : 0}|bridgeEvidence=${resumeBridgeFocusEvidenceRef.current ? 1 : 0}|ime=${Keyboard.isVisible() ? 1 : 0}|metrics=${Math.round(metricsHeight)}|baseline=${keyboardBaselineHeightRef.current === null ? 'null' : Math.round(keyboardBaselineHeightRef.current)}|rootH=${Math.round(keyboardCurrentHeightRef.current)}|safeTop=${Math.round(safeAreaTopRef.current)}|safeBottom=${Math.round(safeAreaBottomRef.current)}|window=${Math.round(windowSize.width)}x${Math.round(windowSize.height)}|kav=${formatFrame(kavFrameRef.current)}|root=${formatFrame(editorRootFrameRef.current)}|scroll=${formatFrame(scrollFrameRef.current)}|toolbar=${formatFrame(toolbarFrameRef.current)}|offset=${Math.round(scrollOffsetRef.current)}|contentH=${Math.round(scrollContentHeightRef.current)}|viewportH=${Math.round(scrollViewportHeightRef.current)}|pending=${pending?.kind ?? 'none'}|target=${targetTop === null ? 'null' : `${Math.round(targetTop)}..${Math.round(targetBottom ?? targetTop)}`}`;
    const ring = lifecycleEventRingRef.current;
    ring.push(snapshot);
    if (ring.length > 250) ring.shift();
  }, []);

  const recordRevealDecision = useCallback((reason: string, detail = '') => {
    recordLifecycleEvent(`reveal:${reason}`, detail);
  }, [recordLifecycleEvent]);

  const getDebugTraceSnapshot = useCallback((includeLastSummary = true) => {
    const windowSize = Dimensions.get('window');
    const screenSize = Dimensions.get('screen');
    const metadata = `platform=${Platform.OS}|version=${String(Platform.Version)}|pixelRatio=${PixelRatio.get()}|window=${Math.round(windowSize.width)}x${Math.round(windowSize.height)}|screen=${Math.round(screenSize.width)}x${Math.round(screenSize.height)}`;
    const summary = includeLastSummary && debugKeyboardTrace
      ? `\nlast-summary:\n${debugKeyboardTrace}`
      : '';
    return [`VIVIDO_KEYBOARD_TRACE`, metadata, ...lifecycleEventRingRef.current, summary].filter(Boolean).join('\n');
  }, [debugKeyboardTrace]);

  const openKeyboardTrace = useCallback(() => {
    if (!__DEV__ || !KEYBOARD_TRACE_ENABLED) return;
    debugKeyboardTraceVisibleRef.current = true;
    setDebugKeyboardTraceError(null);
    setDebugKeyboardTrace(getDebugTraceSnapshot());
    setDebugKeyboardTraceTitle(debugKeyboardTraceTitleRef.current);
    setDebugKeyboardTraceVisible(true);
  }, [getDebugTraceSnapshot]);

  const clearKeyboardTrace = useCallback(() => {
    lifecycleEventRingRef.current = [];
    lifecycleTraceStartedAtRef.current = Date.now();
    lifecycleTraceLastElapsedRef.current = -1;
    setDebugKeyboardTrace(getDebugTraceSnapshot(false));
  }, [getDebugTraceSnapshot]);

  const shareKeyboardTrace = useCallback(async () => {
    if (!__DEV__ || !KEYBOARD_TRACE_ENABLED) return;
    setDebugKeyboardTraceError(null);
    const tracePath = cacheDirectory
      ? `${cacheDirectory}vivido-keyboard-trace-${Date.now()}.txt`
      : null;
    if (!tracePath) {
      setDebugKeyboardTraceError('无法访问临时缓存目录');
      return;
    }
    try {
      await writeAsStringAsync(tracePath, getDebugTraceSnapshot());
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('系统不支持文件分享');
      }
      await Sharing.shareAsync(tracePath, {
        mimeType: 'text/plain',
        dialogTitle: 'Vivido 键盘诊断日志',
      });
    } catch {
      setDebugKeyboardTraceError('诊断日志分享失败，请重试');
    } finally {
      // The share sheet has consumed the temporary file by this point; this
      // best-effort cleanup never touches media or business data.
      await deleteAsync(tracePath, { idempotent: true }).catch(() => undefined);
    }
  }, [getDebugTraceSnapshot]);

  const scheduleLifecycleTraceSummary = useCallback(() => {
    if (!__DEV__ || !KEYBOARD_TRACE_ENABLED || lifecycleTraceTimerRef.current !== null) return;
    lifecycleTraceStartedAtRef.current = Date.now();
    lifecycleEventRingRef.current = [];
    lifecycleTraceLastElapsedRef.current = -1;
    if (!(debugKeyboardTraceTitleRef.current === 'VIVIDO_COLD_KEYBOARD_TRACE'
      && debugKeyboardTraceVisibleRef.current)) {
      debugKeyboardTraceTitleRef.current = 'VIVIDO_KEYBOARD_TRACE';
      debugKeyboardTraceVisibleRef.current = false;
      setDebugKeyboardTrace(null);
      setDebugKeyboardTraceTitle('VIVIDO_KEYBOARD_TRACE');
      setDebugKeyboardTraceVisible(false);
    }
    recordLifecycleEvent('foreground-recovery-start');
    lifecycleTraceTimerRef.current = setTimeout(() => {
      lifecycleTraceTimerRef.current = null;
      recordLifecycleEvent('foreground-recovery-settle');
      // Freeze the string before logging so LogBox inspection cannot observe
      // a later mutation of the ring or alter editor focus/keyboard state.
      const summary = lifecycleEventRingRef.current.join(' <- ');
      if (!(debugKeyboardTraceTitleRef.current === 'VIVIDO_COLD_KEYBOARD_TRACE'
        && debugKeyboardTraceVisibleRef.current)) {
        debugKeyboardTraceTitleRef.current = 'VIVIDO_KEYBOARD_TRACE';
        setDebugKeyboardTraceTitle('VIVIDO_KEYBOARD_TRACE');
        setDebugKeyboardTrace(summary);
      }
      console.warn(`VIVIDO_KEYBOARD_TRACE ${summary}`);
      lifecycleTraceStartedAtRef.current = null;
    }, 2300);
  }, [recordLifecycleEvent]);

  const scheduleColdKeyboardTrace = useCallback((event: KeyboardTraceEvent) => {
    if (!__DEV__ || !KEYBOARD_TRACE_ENABLED || coldKeyboardTraceCapturedRef.current || lifecycleInactiveRef.current
      || appStateRef.current !== 'active' || editorInputOwnerRef.current !== 'editor') return;
    coldKeyboardTraceCapturedRef.current = true;
    coldKeyboardTraceGenerationRef.current += 1;
    const generation = coldKeyboardTraceGenerationRef.current;
    if (coldKeyboardTraceTimerRef.current !== null) {
      clearTimeout(coldKeyboardTraceTimerRef.current);
    }
    const measure = (ref: unknown) => new Promise<{ x: number; y: number; width: number; height: number } | null>((resolve) => {
      const measurable = ref as { measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void } | null;
      if (!measurable?.measureInWindow) {
        resolve(null);
        return;
      }
      measurable.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      coldKeyboardTraceTimerRef.current = setTimeout(async () => {
        coldKeyboardTraceTimerRef.current = null;
        if (!mountedRef.current || generation !== coldKeyboardTraceGenerationRef.current
          || lifecycleInactiveRef.current || appStateRef.current !== 'active') return;
        const [kav, root, scroll, toolbar] = await Promise.all([
          measure(keyboardAvoidingViewRef.current),
          measure(editorRootRef.current),
          measure(editorScrollRef.current),
          measure(keyboardToolbarRef.current),
        ]);
        if (!mountedRef.current || generation !== coldKeyboardTraceGenerationRef.current) return;
        const windowSize = Dimensions.get('window');
        const screenSize = Dimensions.get('screen');
        const keyboardTop = event.endCoordinates.screenY;
        const safeTop = safeAreaTopRef.current;
        const safeBottom = safeAreaBottomRef.current;
        const windowScreenTop = windowScreenTopRef.current;
        const toolbarBottomRaw = toolbar ? toolbar.y + toolbar.height : null;
        const toolbarBottomScreen = toolbarBottomRaw === null ? null : toolbarBottomRaw + windowScreenTop;
        const overlap = toolbarBottomScreen === null ? null : toolbarBottomScreen - keyboardTop;
        const keyboardMetrics = typeof Keyboard.metrics === 'function' ? Keyboard.metrics() : undefined;
        const metricsHeight = keyboardMetrics?.height ?? 0;
        const metricsScreenY = keyboardMetrics?.screenY ?? null;
        const fmt = (value: { x: number; y: number; width: number; height: number } | null) => value
          ? `${Math.round(value.x)},${Math.round(value.y)},${Math.round(value.width)}x${Math.round(value.height)}`
          : 'null';
        const summary = [
          `event=screenY:${Math.round(keyboardTop)},height:${Math.round(event.endCoordinates.height)}`,
          `metricsY=${metricsScreenY === null ? 'null' : Math.round(metricsScreenY)},metricsH=${Math.round(metricsHeight)},window=${Math.round(windowSize.width)}x${Math.round(windowSize.height)},screen=${Math.round(screenSize.width)}x${Math.round(screenSize.height)}`,
          `kav(x,y,w,h)=${fmt(kav)},root=${fmt(root)},scroll=${fmt(scroll)},toolbar=${fmt(toolbar)}`,
          `safeTop=${Math.round(safeTop)},safeBottom=${Math.round(safeBottom)},statusBarHeight=${Math.round(windowScreenTop)},toolbarBottomWindow=${toolbarBottomRaw === null ? 'null' : Math.round(toolbarBottomRaw)},toolbarBottomScreen=${toolbarBottomScreen === null ? 'null' : Math.round(toolbarBottomScreen)},keyboardTop=${Math.round(keyboardTop)},overlapPx=${overlap === null ? 'null' : Math.round(overlap)}`,
          `offset=${Math.round(keyboardAvoidingOffsetRef.current)},phase=${keyboardPhaseRef.current},baseline=${keyboardBaselineHeightRef.current === null ? 'null' : Math.round(keyboardBaselineHeightRef.current)},currentRoot=${Math.round(keyboardCurrentHeightRef.current)}`,
        ].join('\n');
        debugKeyboardTraceTitleRef.current = 'VIVIDO_COLD_KEYBOARD_TRACE';
        setDebugKeyboardTraceTitle('VIVIDO_COLD_KEYBOARD_TRACE');
        setDebugKeyboardTrace(summary);
      }, 150);
    }));
  }, []);

  const setKeyboardPhaseStable = useCallback((next: KeyboardPhase) => {
    keyboardPhaseRef.current = next;
    setKeyboardPhase((current) => (current === next ? current : next));
  }, []);

  const revealKeyboardToolbarAfterLayout = useCallback(() => {
    if (keyboardPhaseRef.current === 'visible') return;
    keyboardToolbarGenerationRef.current += 1;
    const generation = keyboardToolbarGenerationRef.current;
    if (keyboardToolbarFrameRef.current !== null) {
      cancelAnimationFrame(keyboardToolbarFrameRef.current);
    }
    keyboardToolbarFrameRef.current = requestAnimationFrame(() => {
      // KAV's didShow handler performs an async state update. A second frame
      // lets that commit and the resulting flex layout settle before adding
      // the normal toolbar sibling.
      keyboardToolbarFrameRef.current = requestAnimationFrame(() => {
        keyboardToolbarFrameRef.current = null;
        if (generation === keyboardToolbarGenerationRef.current
          && editorInputOwnerRef.current === 'editor'
          && keyboardPositiveEvidenceRef.current) {
          setKeyboardPhaseStable('visible');
        }
      });
    });
  }, [setKeyboardPhaseStable]);

  const cancelResumeEditorFocus = useCallback(() => {
    resumeFocusGenerationRef.current += 1;
    resumeFocusSentRef.current = false;
    if (resumeFocusFrameRef.current !== null) {
      cancelAnimationFrame(resumeFocusFrameRef.current);
      resumeFocusFrameRef.current = null;
    }
    if (resumeWindowFocusFrameRef.current !== null) {
      cancelAnimationFrame(resumeWindowFocusFrameRef.current);
      resumeWindowFocusFrameRef.current = null;
    }
    if (resumeFocusFallbackTimerRef.current !== null) {
      clearTimeout(resumeFocusFallbackTimerRef.current);
      resumeFocusFallbackTimerRef.current = null;
    }
    if (resumeFocusDeadlineTimerRef.current !== null) {
      clearTimeout(resumeFocusDeadlineTimerRef.current);
      resumeFocusDeadlineTimerRef.current = null;
    }
  }, []);

  const confirmResumeEditorFocus = useCallback(() => {
    if (lifecycleBlurPendingRef.current && !lifecycleBlurAckRef.current) return;
    const wasRecovering = foregroundRecoveryActiveRef.current || resumeFocusSentRef.current;
    cancelResumeEditorFocus();
    foregroundRecoveryActiveRef.current = false;
    foregroundRecoveryKeepToolbarRef.current = false;
    if (wasRecovering && __DEV__) {
      recordLifecycleEvent('resume-confirm');
    }
  }, [cancelResumeEditorFocus, recordLifecycleEvent]);

  const attemptResumeEditorFocus = useCallback(() => {
    if (
      !editorKeyboardReturnIntentRef.current ||
      editorInputOwnerRef.current !== 'editor' ||
      appStateRef.current !== 'active' ||
      resumeFocusSentRef.current ||
      (lifecycleBlurPendingRef.current && !lifecycleBlurAckRef.current) ||
      !editorReadyRef.current ||
      !editorRef.current
    ) return;

    const generation = resumeFocusGenerationRef.current;
    const lifecycleGeneration = lifecycleBlurGenerationRef.current;
    resumeFocusSentRef.current = true;
    if (resumeFocusFallbackTimerRef.current !== null) {
      clearTimeout(resumeFocusFallbackTimerRef.current);
      resumeFocusFallbackTimerRef.current = null;
    }
    // Reserve the normal toolbar sibling before asking Android to reconnect
    // the IME. Visibility is still confirmed only by didShow/resize/metrics.
    setKeyboardPhaseStable('visible');
    resumeFocusFrameRef.current = requestAnimationFrame(() => {
      resumeFocusFrameRef.current = null;
      if (
        generation === resumeFocusGenerationRef.current &&
        lifecycleGeneration === lifecycleBlurGenerationRef.current &&
        editorKeyboardReturnIntentRef.current &&
        editorInputOwnerRef.current === 'editor' &&
        appStateRef.current === 'active'
      ) {
        editorRef.current?.focus();
      }
    });
  }, [setKeyboardPhaseStable]);

  const beginResumeEditorFocus = useCallback(() => {
    if (
      !editorKeyboardReturnIntentRef.current ||
      editorInputOwnerRef.current !== 'editor' ||
      appStateRef.current !== 'active'
    ) return;

    cancelResumeEditorFocus();
    resumeBridgeFocusEvidenceRef.current = false;
    const generation = resumeFocusGenerationRef.current;
    foregroundRecoveryActiveRef.current = true;
    foregroundRecoveryKeepToolbarRef.current = true;
    // The captured pre-background keyboard-open intent is a temporary,
    // responsive toolbar hold.  The bounded restore outcome below still
    // settles it to hidden if the IME does not actually return.
    setKeyboardPhaseStable('visible');
    resumeFocusFallbackTimerRef.current = setTimeout(() => {
      resumeFocusFallbackTimerRef.current = null;
      if (generation === resumeFocusGenerationRef.current) attemptResumeEditorFocus();
    }, 250);
    resumeFocusDeadlineTimerRef.current = setTimeout(() => {
      resumeFocusDeadlineTimerRef.current = null;
      if (generation !== resumeFocusGenerationRef.current || !editorKeyboardReturnIntentRef.current) return;
      if (lifecycleBlurPendingRef.current && !lifecycleBlurAckRef.current) {
        // The WebView may have been paused before its queued blur was
        // delivered. Give that command one bounded handoff opportunity rather
        // than racing it with focus; the next frame is the only fallback.
        lifecycleBlurPendingRef.current = false;
        lifecycleBlurAckRef.current = true;
        requestAnimationFrame(() => attemptResumeEditorFocus());
        resumeFocusDeadlineTimerRef.current = setTimeout(() => {
          if (
            generation === resumeFocusGenerationRef.current &&
            editorKeyboardReturnIntentRef.current &&
            !keyboardPositiveEvidenceRef.current
          ) {
            editorKeyboardReturnIntentRef.current = false;
            foregroundRecoveryActiveRef.current = false;
            foregroundRecoveryKeepToolbarRef.current = false;
            setKeyboardPhaseStable('hidden');
            cancelResumeEditorFocus();
          }
        }, 1000);
        return;
      }
      if (!keyboardPositiveEvidenceRef.current) {
        editorKeyboardReturnIntentRef.current = false;
        foregroundRecoveryActiveRef.current = false;
        foregroundRecoveryKeepToolbarRef.current = false;
        setKeyboardPhaseStable('hidden');
        cancelResumeEditorFocus();
      }
    }, 1200);
  }, [attemptResumeEditorFocus, cancelResumeEditorFocus, setKeyboardPhaseStable]);

  const handleEditorFocusChange = useCallback((focused: boolean) => {
    recordLifecycleEvent(focused ? 'editor-focus' : 'editor-blur');
    if (!focused && lifecycleBlurPendingRef.current) {
      // Consume only the false focus report belonging to the lifecycle blur;
      // ordinary transient TenTap blurs remain ignored by the last-owner model.
      lifecycleBlurAckRef.current = true;
      lifecycleBlurPendingRef.current = false;
      if (
        appStateRef.current === 'active' &&
        editorKeyboardReturnIntentRef.current &&
        editorInputOwnerRef.current === 'editor'
      ) {
        requestAnimationFrame(() => attemptResumeEditorFocus());
      }
      return;
    }
    if (focused) {
      const alreadyOwnedByEditor = editorInputOwnerRef.current === 'editor';
      if (alreadyOwnedByEditor) {
        // During a controlled resume, TenTap's positive focus state is useful
        // bridge evidence even if Android has not emitted didShow yet. A
        // normal repeated focus/touch after an intentional hide remains a
        // no-op, preserving the no-toolbar-after-scroll behavior.
        if (appStateRef.current === 'active'
          && editorKeyboardReturnIntentRef.current
          && resumeFocusSentRef.current) {
          resumeBridgeFocusEvidenceRef.current = true;
          keyboardPositiveEvidenceRef.current = true;
          keyboardHiddenEvidenceRef.current = false;
          keyboardHidePendingRef.current = false;
          setKeyboardPhaseStable('visible');
          confirmResumeEditorFocus();
        }
        return;
      }
      editorInputOwnerRef.current = 'editor';
      if (appStateRef.current !== 'active') return;
      suppressRevealAfterManualScrollRef.current = false;
      const caret = latestCaretRectRef.current;
      if (caret && !manualScrollActiveRef.current) {
        pendingRevealRef.current = { kind: 'caret', top: caret.top, bottom: caret.bottom };
      }
      if (Keyboard.isVisible()
        || (typeof Keyboard.metrics === 'function' && Boolean(Keyboard.metrics()?.height))) {
        keyboardPositiveEvidenceRef.current = true;
        keyboardHidePendingRef.current = false;
        keyboardHiddenEvidenceRef.current = false;
        revealKeyboardToolbarAfterLayout();
      } else {
        // Focus alone is not keyboard evidence; wait for didShow/resize.
        setKeyboardPhaseStable('hidden');
      }
    } else if (editorInputOwnerRef.current === 'editor') {
      // TenTap can emit a transient blur during commands, WebView reflow, or
      // app/IME transitions. In the last-owner model this snapshot is not an
      // ownership transition: keyboard/root/AppState signals own phase
      // changes, while title/tag focus explicitly switches owner to `other`.
      // Keep the last editor owner; actual keyboard events own visibility.
      return;
    }
  }, [attemptResumeEditorFocus, confirmResumeEditorFocus, recordLifecycleEvent, setKeyboardPhaseStable]);

  const handleNonEditorFocusChange = useCallback((focused: boolean) => {
    if (focused) recordLifecycleEvent('non-editor-focus');
    if (focused) {
      if (appStateRef.current !== 'active') return;
      keyboardPositiveEvidenceRef.current = false;
      keyboardHidePendingRef.current = false;
      editorInputOwnerRef.current = 'other';
      keyboardHiddenEvidenceRef.current = false;
      editorKeyboardReturnIntentRef.current = false;
      resumeBridgeFocusEvidenceRef.current = false;
      lifecycleBlurGenerationRef.current += 1;
      lifecycleBlurPendingRef.current = false;
      lifecycleBlurAckRef.current = false;
      foregroundRecoveryActiveRef.current = false;
      foregroundRecoveryKeepToolbarRef.current = false;
      cancelResumeEditorFocus();
      setKeyboardPhaseStable('hidden');
    }
  }, [cancelResumeEditorFocus, recordLifecycleEvent, setKeyboardPhaseStable]);

  const resetEditorKeyboardSession = useCallback(() => {
    // A real didShow starts a new IME session.  It must not inherit a
    // lifecycle blur that was pending when a closed editor went background.
    cancelResumeEditorFocus();
    lifecycleBlurGenerationRef.current += 1;
    lifecycleBlurPendingRef.current = false;
    lifecycleBlurAckRef.current = false;
    lifecycleBlurSentRef.current = false;
    foregroundRecoveryActiveRef.current = false;
    foregroundRecoveryKeepToolbarRef.current = false;
    editorKeyboardReturnIntentRef.current = true;
    resumeBridgeFocusEvidenceRef.current = false;
    keyboardPositiveEvidenceRef.current = true;
    keyboardHiddenEvidenceRef.current = false;
    keyboardHidePendingRef.current = false;
    keyboardFullHeightStableCountRef.current = 0;
    recordLifecycleEvent('keyboard-session-reset');
  }, [cancelResumeEditorFocus, recordLifecycleEvent]);

  const runPendingReveal = useCallback(() => {
    const pending = pendingRevealRef.current;
    if (!pending) return;
    if (appStateRef.current !== 'active') {
      recordRevealDecision('rejected-app-state', appStateRef.current);
      return;
    }
    if (manualScrollActiveRef.current) {
      recordRevealDecision('rejected-manual-drag');
      return;
    }
    if (suppressRevealAfterManualScrollRef.current) {
      recordRevealDecision('rejected-manual-suppression');
      return;
    }
    const owner = editorInputOwnerRef.current;
    const baseline = keyboardBaselineHeightRef.current;
    const current = keyboardCurrentHeightRef.current;
    const layoutIsResized = baseline !== null && current > 0 && baseline - current > 48;
    const keyboardVisible = layoutIsResized || (typeof Keyboard.metrics === 'function' && Boolean(Keyboard.metrics()?.height)) || Keyboard.isVisible();
    if (pending.kind === 'caret') {
      if (owner !== 'editor' || keyboardPhaseRef.current !== 'visible' || !editorReadyRef.current) {
        recordRevealDecision('rejected-caret-gate', `${owner ?? 'none'},${keyboardPhaseRef.current},${editorReadyRef.current ? 1 : 0}`);
        return;
      }
    } else if (owner !== 'other' || !tagInputFocusedRef.current || !keyboardVisible) {
      recordRevealDecision('rejected-tag-gate', `${owner ?? 'none'},${tagInputFocusedRef.current ? 1 : 0},${keyboardVisible ? 1 : 0}`);
      return;
    }
    const viewportHeight = scrollViewportHeightRef.current;
    const contentHeight = scrollContentHeightRef.current;
    if (viewportHeight <= 0 || contentHeight <= 0) {
      recordRevealDecision('rejected-layout', `${contentHeight},${viewportHeight}`);
      return;
    }
    const targetTop = pending.kind === 'caret' && latestCaretRectRef.current
      ? editorAreaTopRef.current + editorHostTopRef.current + latestCaretRectRef.current.top
      : pending.top;
    const targetBottom = pending.kind === 'caret' && latestCaretRectRef.current
      ? editorAreaTopRef.current + editorHostTopRef.current + latestCaretRectRef.current.bottom
      : pending.bottom;
    const scrollOffset = scrollOffsetRef.current;
    const safeTop = scrollOffset + 12;
    const safeBottom = scrollOffset + viewportHeight - 12;
    if (targetTop >= safeTop && targetBottom <= safeBottom) {
      recordRevealDecision('visible-no-scroll', `${Math.round(targetTop)}..${Math.round(targetBottom)}`);
      pendingRevealRef.current = null;
      lastRevealCommandRef.current = null;
      return;
    }
    const desired = targetBottom > safeBottom
      ? targetBottom + 12 - viewportHeight
      : targetTop - 12;
    const maxScroll = Math.max(0, contentHeight - viewportHeight);
    if (desired > maxScroll + 1) {
      recordRevealDecision('rejected-max-scroll', `${Math.round(desired)}>${Math.round(maxScroll)}`);
      return;
    }
    const target = Math.max(0, Math.min(maxScroll, desired));
    const previous = lastRevealCommandRef.current;
    if (
      previous &&
      previous.kind === pending.kind &&
      previous.target === target &&
      previous.contentHeight === contentHeight &&
      previous.viewportHeight === viewportHeight
    ) {
      recordRevealDecision('duplicate-scroll', `${Math.round(target)}`);
      return;
    }
    if (Math.abs(target - scrollOffset) < 2) {
      recordRevealDecision('within-threshold', `${Math.round(target)}~${Math.round(scrollOffset)}`);
      pendingRevealRef.current = null;
      lastRevealCommandRef.current = null;
      return;
    }
    lastRevealCommandRef.current = { kind: pending.kind, target, contentHeight, viewportHeight };
    recordLifecycleEvent('scrollTo', `trigger=${pending.kind}|target=${Math.round(target)}`);
    editorScrollRef.current?.scrollTo({ y: target, animated: false });
    if (pending.kind === 'caret') {
      pendingRevealRef.current = null;
    }
  }, [recordLifecycleEvent, recordRevealDecision]);

  const scheduleReveal = useCallback(() => {
    if (caretEnsureFrameRef.current !== null) cancelAnimationFrame(caretEnsureFrameRef.current);
    caretEnsureFrameRef.current = requestAnimationFrame(() => {
      caretEnsureFrameRef.current = null;
      runPendingReveal();
    });
  }, [runPendingReveal]);
  const queueCaretReveal = useCallback((caret: RichEditorActiveState['caretRect']) => {
    latestCaretRectRef.current = caret;
    if (caret) {
      const previous = lastCaretGeometryRef.current;
      const changed = !previous
        || Math.abs(previous.top - caret.top) > 1
        || Math.abs(previous.bottom - caret.bottom) > 1;
      lastCaretGeometryRef.current = { top: caret.top, bottom: caret.bottom };
      if (manualScrollActiveRef.current) return;
      if (inputRevealRequestedRef.current && editorInputOwnerRef.current === 'editor') {
        // Dirty only records intent. The first subsequent state callback owns
        // the latest caret geometry used for this single visibility check.
        inputRevealRequestedRef.current = false;
        explicitCaretRevealRequestedRef.current = false;
        suppressRevealAfterManualScrollRef.current = false;
        pendingRevealRef.current = { kind: 'caret', top: caret.top, bottom: caret.bottom };
        recordLifecycleEvent('reveal-pending', 'kind=caret|trigger=input-state');
        lastRevealCommandRef.current = null;
        scheduleReveal();
        return;
      }
      const hasExplicitInteraction = explicitCaretRevealRequestedRef.current;
      if (hasExplicitInteraction) {
        explicitCaretRevealRequestedRef.current = false;
        suppressRevealAfterManualScrollRef.current = false;
        pendingRevealRef.current = { kind: 'caret', top: caret.top, bottom: caret.bottom };
        recordLifecycleEvent('reveal-pending', 'kind=caret|trigger=interaction');
        lastRevealCommandRef.current = null;
        scheduleReveal();
        return;
      }
      if (suppressRevealAfterManualScrollRef.current && !changed) return;
      suppressRevealAfterManualScrollRef.current = false;
      if (editorInputOwnerRef.current === 'editor') {
        pendingRevealRef.current = { kind: 'caret', top: caret.top, bottom: caret.bottom };
        recordLifecycleEvent('reveal-pending', 'kind=caret|trigger=state');
      }
    } else if (!caret && pendingRevealRef.current?.kind === 'caret') {
      pendingRevealRef.current = null;
    }
    scheduleReveal();
  }, [recordLifecycleEvent, scheduleReveal]);

  const queueCaretRevealAfterInput = useCallback(() => {
    const caret = latestCaretRectRef.current;
    if (!caret || editorInputOwnerRef.current !== 'editor' || appStateRef.current !== 'active') return;
    if (manualScrollActiveRef.current) {
      inputRevealRequestedRef.current = true;
      return;
    }
    inputRevealRequestedRef.current = false;
    suppressRevealAfterManualScrollRef.current = false;
    pendingRevealRef.current = { kind: 'caret', top: caret.top, bottom: caret.bottom };
    recordLifecycleEvent('reveal-pending', 'kind=caret|trigger=input-after-scroll');
    lastRevealCommandRef.current = null;
    scheduleReveal();
  }, [recordLifecycleEvent, scheduleReveal]);

  const revealTagInput = useCallback(() => {
    const inputBottom = tagInputBottomRef.current;
    if (inputBottom === null) return;
    suppressRevealAfterManualScrollRef.current = false;
    const bottom = tagEditorTopRef.current + inputBottom;
    pendingRevealRef.current = { kind: 'tag', top: bottom, bottom };
    recordLifecycleEvent('reveal-pending', 'kind=tag');
    scheduleReveal();
  }, [recordLifecycleEvent, scheduleReveal]);

  useEffect(() => {
    scheduleReveal();
    return () => {
      if (caretEnsureFrameRef.current !== null) {
        cancelAnimationFrame(caretEnsureFrameRef.current);
        caretEnsureFrameRef.current = null;
      }
    };
  }, [keyboardPhase, scheduleReveal]);

  useEffect(() => {
    if (isEditing && diaryId) {
      setEntryLoaded(false);
      setEditorReady(false);
      setEditorLoadError(null);
      loadDiary(diaryId);
    } else {
      setEntryLoaded(true);
      setEditorLoadError(null);
      checkDraft();
    }
  }, [diaryId]);

  const handleEditorRootLayout = useCallback((height: number) => {
    if (height <= 0 || appStateRef.current !== 'active') return;
    recordLifecycleEvent(`root:${Math.round(height)}`);
    keyboardCurrentHeightRef.current = height;
    scheduleReveal();

    const metricsVisible = typeof Keyboard.metrics === 'function' && Boolean(Keyboard.metrics()?.height);
    const systemKeyboardVisible = metricsVisible || Keyboard.isVisible();
    const baseline = keyboardBaselineHeightRef.current;
    if (baseline === null) {
      // Do not learn a baseline from a first layout observed during an
      // visible recovery transition.
      if (!keyboardHiddenEvidenceRef.current || systemKeyboardVisible || keyboardPhaseRef.current !== 'hidden') return;
      keyboardBaselineHeightRef.current = height;
      keyboardFullHeightStableCountRef.current = 0;
      return;
    }

    const resizedForKeyboard = baseline - height > 48;
    if (resizedForKeyboard) {
      keyboardFullHeightStableCountRef.current = 0;
      if (editorInputOwnerRef.current === 'editor') {
        if (lifecycleBlurPendingRef.current && !editorKeyboardReturnIntentRef.current) {
          setKeyboardPhaseStable('hidden');
          return;
        }
        keyboardPositiveEvidenceRef.current = true;
        keyboardHiddenEvidenceRef.current = false;
        if (editorKeyboardReturnIntentRef.current) {
          resumeBridgeFocusEvidenceRef.current = true;
          confirmResumeEditorFocus();
        }
        // KAV subscribes to the same didShow event and needs one layout pass
        // before the toolbar is mounted into the reduced-height sibling row.
        revealKeyboardToolbarAfterLayout();
      } else if (editorInputOwnerRef.current === 'other' && tagInputFocusedRef.current) {
        revealTagInput();
      }
      return;
    }

    if (systemKeyboardVisible) {
      if (editorInputOwnerRef.current === 'editor') {
        if (lifecycleBlurPendingRef.current && !editorKeyboardReturnIntentRef.current) {
          setKeyboardPhaseStable('hidden');
          return;
        }
        keyboardPositiveEvidenceRef.current = true;
        keyboardHiddenEvidenceRef.current = false;
        if (editorKeyboardReturnIntentRef.current) {
          resumeBridgeFocusEvidenceRef.current = true;
          confirmResumeEditorFocus();
        }
        revealKeyboardToolbarAfterLayout();
      }
      keyboardFullHeightStableCountRef.current = 0;
      return;
    }

    if (foregroundRecoveryActiveRef.current && foregroundRecoveryKeepToolbarRef.current
      && editorInputOwnerRef.current === 'editor') {
      // Full-height samples during Activity recovery are not enough to prove
      // that the keyboard was intentionally dismissed.
      keyboardFullHeightStableCountRef.current = 0;
      return;
    }

    // With Android pan (or a resumed WebView that does not emit another
    // didShow), a positive TenTap focus is the only reliable resume signal.
    // Do not turn that confirmed editor session off merely because the root
    // remained full-height. A subsequent real keyboardDidHide clears it.
    if (resumeBridgeFocusEvidenceRef.current && editorInputOwnerRef.current === 'editor') {
      keyboardFullHeightStableCountRef.current = 0;
      return;
    }

    if (keyboardHidePendingRef.current && editorInputOwnerRef.current === 'editor') {
      keyboardFullHeightStableCountRef.current += 1;
      if (keyboardFullHeightStableCountRef.current >= 3) {
        keyboardPositiveEvidenceRef.current = false;
        keyboardHidePendingRef.current = false;
        keyboardHiddenEvidenceRef.current = true;
        keyboardBaselineHeightRef.current = height;
        keyboardFullHeightStableCountRef.current = 0;
        setKeyboardPhaseStable('hidden');
      }
      return;
    }

    if (keyboardHiddenEvidenceRef.current && keyboardPhaseRef.current === 'hidden') {
      // Baseline may legitimately move with system bars, but only while the
      // keyboard is explicitly known to be hidden.
      keyboardBaselineHeightRef.current = height;
      keyboardFullHeightStableCountRef.current = 0;
      return;
    }

    // A keyboard closed while the app was backgrounded may not emit
    // keyboardDidHide. Require repeated full-height measurements before
    // treating the return to the known full-height region as hide evidence.
    if (editorInputOwnerRef.current === 'editor' && keyboardPositiveEvidenceRef.current) {
      keyboardFullHeightStableCountRef.current += 1;
      if (keyboardFullHeightStableCountRef.current >= 3) {
        keyboardPositiveEvidenceRef.current = false;
        keyboardHidePendingRef.current = false;
        keyboardHiddenEvidenceRef.current = true;
        keyboardBaselineHeightRef.current = height;
        keyboardFullHeightStableCountRef.current = 0;
        setKeyboardPhaseStable('hidden');
      }
    } else {
      keyboardFullHeightStableCountRef.current = 0;
    }
  }, [confirmResumeEditorFocus, recordLifecycleEvent, revealTagInput, scheduleReveal, setKeyboardPhaseStable]);

  useEffect(() => {
    let activeSyncFrame: number | null = null;
    let activeSyncCount = 0;
    const syncKeyboardVisibility = () => {
      if (appStateRef.current !== 'active') return;
      const generation = foregroundRecoveryGenerationRef.current;
      const protectedRecoverySample = foregroundRecoveryActiveRef.current
        && foregroundRecoveryKeepToolbarRef.current;
      editorRootRef.current?.measureInWindow((_x, _y, _width, height) => {
        if (appStateRef.current === 'active'
          && generation === foregroundRecoveryGenerationRef.current
          && height > 0) {
          if (protectedRecoverySample) {
            // This sample was requested during the protected recovery window;
            // keep the latest raw height but do not let its callback confirm a
            // premature full-height hide after the window advances.
            keyboardCurrentHeightRef.current = height;
            scheduleReveal();
            return;
          }
          handleEditorRootLayout(height);
        }
      });
      const baseline = keyboardBaselineHeightRef.current;
      const current = keyboardCurrentHeightRef.current;
      const layoutIsResized = baseline !== null && current > 0 && baseline - current > 48;
      const metricsVisible = typeof Keyboard.metrics === 'function' && Boolean(Keyboard.metrics()?.height);
      const keyboardVisible = layoutIsResized || metricsVisible || Keyboard.isVisible();
      if (editorInputOwnerRef.current === 'editor' && keyboardVisible) {
        if (lifecycleBlurPendingRef.current && !editorKeyboardReturnIntentRef.current) {
          setKeyboardPhaseStable('hidden');
          return;
        }
        keyboardPositiveEvidenceRef.current = true;
        keyboardHiddenEvidenceRef.current = false;
        if (editorKeyboardReturnIntentRef.current) {
          resumeBridgeFocusEvidenceRef.current = true;
          confirmResumeEditorFocus();
        }
        revealKeyboardToolbarAfterLayout();
      } else if (editorInputOwnerRef.current !== 'editor') {
        keyboardPositiveEvidenceRef.current = false;
        keyboardHidePendingRef.current = false;
        setKeyboardPhaseStable('hidden');
        if (tagInputFocusedRef.current && keyboardVisible) revealTagInput();
      }
    };
    const scheduleActiveSync = () => {
      if (activeSyncFrame !== null) cancelAnimationFrame(activeSyncFrame);
      activeSyncCount = 0;
      let settlementFrames = 0;
      const maxActiveSyncFrames = 18;
      const preserveToolbar = foregroundRecoveryKeepToolbarRef.current;
      foregroundRecoveryKeepToolbarRef.current = preserveToolbar;
      foregroundRecoveryActiveRef.current = preserveToolbar;
      foregroundRecoveryGenerationRef.current += 1;
      const syncFrame = () => {
        activeSyncFrame = null;
        if (appStateRef.current !== 'active') return;
        syncKeyboardVisibility();
        activeSyncCount += 1;
        if (activeSyncCount < maxActiveSyncFrames) {
          activeSyncFrame = requestAnimationFrame(syncFrame);
        } else if ((preserveToolbar || settlementFrames > 0) && settlementFrames < 3) {
          // Only after the protected recovery window do full-height samples
          // participate in the stable-hide confirmation.
          if (settlementFrames === 0) {
            foregroundRecoveryActiveRef.current = false;
            foregroundRecoveryKeepToolbarRef.current = false;
          }
          settlementFrames += 1;
          activeSyncFrame = requestAnimationFrame(syncFrame);
        } else {
          foregroundRecoveryActiveRef.current = false;
          foregroundRecoveryKeepToolbarRef.current = false;
        }
      };
      activeSyncFrame = requestAnimationFrame(syncFrame);
    };
    const willShowSubscription = Keyboard.addListener('keyboardWillShow', (event) => {
      recordLifecycleEvent('keyboard-will-show', `screenY=${Math.round(event.endCoordinates.screenY)}|height=${Math.round(event.endCoordinates.height)}`);
    });
    const willHideSubscription = Keyboard.addListener('keyboardWillHide', (event) => {
      recordLifecycleEvent('keyboard-will-hide', `screenY=${Math.round(event.endCoordinates.screenY)}|height=${Math.round(event.endCoordinates.height)}`);
    });
    const showSubscription = Keyboard.addListener('keyboardDidShow', (event) => {
      recordLifecycleEvent('keyboard-show', `screenY=${Math.round(event.endCoordinates.screenY)}|height=${Math.round(event.endCoordinates.height)}`);
      scheduleColdKeyboardTrace(event);
      // A lifecycle blur owns the editor while the Activity is not visible;
      // do not let a late show from the old WebView session rewrite state.
      if (appStateRef.current !== 'active') return;
      if (appStateRef.current === 'active') Keyboard.scheduleLayoutAnimation(event);
      if (editorInputOwnerRef.current === 'editor') {
        resetEditorKeyboardSession();
        if (lifecycleBlurPendingRef.current && !editorKeyboardReturnIntentRef.current) {
          setKeyboardPhaseStable('hidden');
          return;
        }
        keyboardPositiveEvidenceRef.current = true;
        keyboardHidePendingRef.current = false;
        keyboardHiddenEvidenceRef.current = false;
        keyboardFullHeightStableCountRef.current = 0;
        if (editorKeyboardReturnIntentRef.current) {
          resumeBridgeFocusEvidenceRef.current = true;
          confirmResumeEditorFocus();
        }
        revealKeyboardToolbarAfterLayout();
      } else {
        keyboardPositiveEvidenceRef.current = false;
        keyboardHidePendingRef.current = false;
        setKeyboardPhaseStable('hidden');
        if (tagInputFocusedRef.current) revealTagInput();
      }
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', (event) => {
      recordLifecycleEvent('keyboard-hide', `screenY=${Math.round(event.endCoordinates.screenY)}|height=${Math.round(event.endCoordinates.height)}`);
      keyboardToolbarGenerationRef.current += 1;
      if (keyboardToolbarFrameRef.current !== null) {
        cancelAnimationFrame(keyboardToolbarFrameRef.current);
        keyboardToolbarFrameRef.current = null;
      }
      if (appStateRef.current === 'active') Keyboard.scheduleLayoutAnimation(event);
      keyboardFullHeightStableCountRef.current = 0;
      if (appStateRef.current !== 'active') {
        if (editorInputOwnerRef.current === 'editor') {
          // Blur-induced hide must not rewrite the frozen resume intent.
          keyboardHidePendingRef.current = true;
          keyboardHiddenEvidenceRef.current = false;
        }
        return;
      }
      if (editorInputOwnerRef.current === 'editor') {
        if (foregroundRecoveryActiveRef.current && editorKeyboardReturnIntentRef.current) {
          // A keyboardDidHide delivered during the bounded foreground handoff
          // can belong to the pre-background WebView session. Keep the
          // toolbar and return intent; later positive evidence (or the bounded
          // recovery outcome) classifies this event.
          keyboardHidePendingRef.current = true;
          keyboardHiddenEvidenceRef.current = false;
          scheduleActiveSync();
          return;
        }
        // A hide is only a candidate; root full-height measurements confirm it.
        // Hide the toolbar immediately.  A stale editor/WebView focus must not
        // keep a formatting bar visible after the IME has actually closed;
        // later resize/show evidence may mount it again for a real reopen.
        keyboardPositiveEvidenceRef.current = false;
        setKeyboardPhaseStable('hidden');
        resumeBridgeFocusEvidenceRef.current = false;
        keyboardHidePendingRef.current = true;
        keyboardHiddenEvidenceRef.current = false;
      } else {
        keyboardPositiveEvidenceRef.current = false;
        keyboardHidePendingRef.current = false;
        keyboardHiddenEvidenceRef.current = true;
        setKeyboardPhaseStable('hidden');
      }
      scheduleActiveSync();
    });
    // Android may report window blur before the AppState change/background
    // event. Both paths share one idempotent boundary so the pre-hide keyboard
    // snapshot is frozen before any lifecycle-induced keyboardDidHide arrives.
    const enterLifecycleInactive = (state: 'inactive' | 'background') => {
      appStateRef.current = state;
      recordLifecycleEvent(`app-${state}`);
      if (!lifecycleInactiveRef.current) {
        lifecycleInactiveRef.current = true;
        const metricsVisible = typeof Keyboard.metrics === 'function' && Boolean(Keyboard.metrics()?.height);
        const baseline = keyboardBaselineHeightRef.current;
        const current = keyboardCurrentHeightRef.current;
        const resizedForKeyboard = baseline !== null && current > 0 && baseline - current > 48;
        editorKeyboardReturnIntentRef.current = editorInputOwnerRef.current === 'editor'
          && (keyboardPhaseRef.current === 'visible'
            || keyboardPositiveEvidenceRef.current
            || metricsVisible
            || Keyboard.isVisible()
            || resizedForKeyboard)
          && !keyboardHiddenEvidenceRef.current;
        foregroundRecoveryKeepToolbarRef.current = editorKeyboardReturnIntentRef.current;
        foregroundRecoveryGenerationRef.current += 1;
        foregroundRecoveryActiveRef.current = false;
        resumeBridgeFocusEvidenceRef.current = false;
        cancelResumeEditorFocus();
        lifecycleBlurGenerationRef.current += 1;
        lifecycleBlurPendingRef.current = true;
        lifecycleBlurAckRef.current = false;
        // Subsequent evidence belongs to the resumed session, not the old
        // focused WebView. The return intent above is the frozen snapshot.
        keyboardPositiveEvidenceRef.current = false;
        keyboardHidePendingRef.current = false;
        keyboardHiddenEvidenceRef.current = true;
        if (!lifecycleBlurSentRef.current && editorRef.current) {
          editorRef.current.blur();
          lifecycleBlurSentRef.current = true;
        }
        if (editorInputOwnerRef.current === 'editor') setKeyboardPhaseStable('hidden');
      }
      if (activeSyncFrame !== null) cancelAnimationFrame(activeSyncFrame);
      activeSyncFrame = null;
    };
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      recordLifecycleEvent(`app-change:${state}`);
      if (state !== 'active') {
        enterLifecycleInactive(state === 'background' ? 'background' : 'inactive');
        return;
      }
      lifecycleInactiveRef.current = false;
      lifecycleBlurSentRef.current = false;
      appStateRef.current = state;
      scheduleLifecycleTraceSummary();
      if (editorKeyboardReturnIntentRef.current && editorInputOwnerRef.current === 'editor') {
        if (!foregroundRecoveryActiveRef.current) beginResumeEditorFocus();
      } else {
        cancelResumeEditorFocus();
        setKeyboardPhaseStable('hidden');
      }
      scheduleActiveSync();
    });
    const lifecycleBlurSubscription = AppState.addEventListener('blur', () => {
      recordLifecycleEvent('app-blur');
      enterLifecycleInactive('inactive');
    });
    const windowFocusSubscription = AppState.addEventListener('focus', () => {
      recordLifecycleEvent('app-focus');
      // Android can deliver window focus before the AppState `active` change.
      // Treat this as an early foreground signal only; it never creates a
      // closed-session keyboard intent.
      appStateRef.current = 'active';
      if (editorKeyboardReturnIntentRef.current
        && editorInputOwnerRef.current === 'editor'
        && !foregroundRecoveryActiveRef.current) {
        beginResumeEditorFocus();
      }
      if (editorKeyboardReturnIntentRef.current && editorInputOwnerRef.current === 'editor') {
        if (resumeWindowFocusFrameRef.current !== null) {
          cancelAnimationFrame(resumeWindowFocusFrameRef.current);
        }
        const generation = resumeFocusGenerationRef.current;
        const lifecycleGeneration = lifecycleBlurGenerationRef.current;
        resumeWindowFocusFrameRef.current = requestAnimationFrame(() => {
          resumeWindowFocusFrameRef.current = null;
          if (
            generation === resumeFocusGenerationRef.current &&
            lifecycleGeneration === lifecycleBlurGenerationRef.current &&
            appStateRef.current === 'active' &&
            editorKeyboardReturnIntentRef.current &&
            editorInputOwnerRef.current === 'editor'
          ) {
            attemptResumeEditorFocus();
          }
        });
      }
      scheduleLifecycleTraceSummary();
      scheduleActiveSync();
    });
    // Refresh after the listener is installed so a foreground transition
    // between render and effect setup cannot leave this ref permanently stale.
    const currentAppState = AppState.currentState;
    if (currentAppState === 'active') {
      appStateRef.current = 'active';
      lifecycleInactiveRef.current = false;
    } else if (currentAppState === 'background' || currentAppState === 'inactive') {
      appStateRef.current = currentAppState;
      lifecycleInactiveRef.current = true;
    }
    if (appStateRef.current === 'active' && currentAppState !== 'background' && currentAppState !== 'inactive') {
      scheduleActiveSync();
    }
    return () => {
      if (activeSyncFrame !== null) cancelAnimationFrame(activeSyncFrame);
      cancelResumeEditorFocus();
      if (lifecycleTraceTimerRef.current !== null) {
        clearTimeout(lifecycleTraceTimerRef.current);
        lifecycleTraceTimerRef.current = null;
      }
      coldKeyboardTraceGenerationRef.current += 1;
      if (coldKeyboardTraceTimerRef.current !== null) {
        clearTimeout(coldKeyboardTraceTimerRef.current);
        coldKeyboardTraceTimerRef.current = null;
      }
      keyboardToolbarGenerationRef.current += 1;
      if (keyboardToolbarFrameRef.current !== null) {
        cancelAnimationFrame(keyboardToolbarFrameRef.current);
        keyboardToolbarFrameRef.current = null;
      }
      willShowSubscription.remove();
      willHideSubscription.remove();
      showSubscription.remove();
      hideSubscription.remove();
      appStateSubscription.remove();
      lifecycleBlurSubscription.remove();
      windowFocusSubscription.remove();
    };
  }, [
    attemptResumeEditorFocus,
    beginResumeEditorFocus,
    cancelResumeEditorFocus,
    confirmResumeEditorFocus,
    handleEditorRootLayout,
    recordLifecycleEvent,
    resetEditorKeyboardSession,
    revealKeyboardToolbarAfterLayout,
    scheduleColdKeyboardTrace,
    scheduleLifecycleTraceSummary,
    revealTagInput,
    scheduleReveal,
    setKeyboardPhaseStable,
  ]);

  useEffect(() => {
    if (!editorReady || !editorRef.current) return;
    editorRef.current.setMediaPreviews(
      media.map((item) => ({
        mediaId: item.id,
        mediaType: item.type,
        uri: item.type === 'image' ? item.uri : undefined,
        thumbnailUri: item.type === 'video' ? item.thumbnail : undefined,
        label: item.fileName ?? null,
      })),
    );
  }, [editorReady, media]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!entryLoaded || editorReady || editorLoadError) return;

    const timeout = setTimeout(() => {
      setEditorLoadError('编辑器加载超时，请重试');
    }, 9000);

    return () => clearTimeout(timeout);
  }, [entryLoaded, editorReady, editorLoadError, editorMountKey]);

  const retryEditor = () => {
    editorRef.current = null;
    handleNonEditorFocusChange(true);
    setEditorActiveState((current) => ({ ...current, isReady: false }));
    setEditorReady(false);
    setEditorLoadError(null);
    setEditorMountKey((current) => current + 1);
  };

  const runVideoThumbnailQueue = async (): Promise<void> => {
    if (videoThumbnailWorkerRef.current) return;
    videoThumbnailWorkerRef.current = true;
    try {
      while (videoThumbnailQueueRef.current.length > 0) {
        const next = videoThumbnailQueueRef.current.shift();
        if (!next) continue;
        const result = await createPersistentVideoThumbnail(next.item);
        if (result) {
          const original = originalMediaRef.current.find((item) => item.id === result.id);
          if ((!original || !original.thumbnail) && result.thumbnail) {
            generatedThumbnailDerivativesRef.current.set(result.id, result.thumbnail);
          }
          stagedMediaRef.current = stagedMediaRef.current.map((staged) =>
            staged.id === result.id ? result : staged,
          );
          if (mountedRef.current) {
            setMedia((current) => current.map((currentItem) =>
              currentItem.id === result.id ? result : currentItem,
            ));
          }
        } else {
          // One failed attempt per session keeps a missing-frame fallback
          // stable without creating a retry loop or player churn.
          videoThumbnailFailedRef.current.add(next.item.id);
        }
        next.resolve(result);
        videoThumbnailTasksRef.current.delete(next.item.id);
      }
    } finally {
      videoThumbnailWorkerRef.current = false;
    }
  };

  const startVideoThumbnailTask = (item: MediaItem): Promise<MediaItem | null> | null => {
    if (item.type !== 'video' || item.thumbnail || videoThumbnailFailedRef.current.has(item.id)) return null;
    const existing = videoThumbnailTasksRef.current.get(item.id);
    if (existing) return existing;

    let resolveTask!: (result: MediaItem | null) => void;
    const task = new Promise<MediaItem | null>((resolve) => {
      resolveTask = resolve;
    });
    videoThumbnailTasksRef.current.set(item.id, task);
    videoThumbnailQueueRef.current.push({ item, resolve: resolveTask });
    void runVideoThumbnailQueue();
    return task;
  };

  const flushVideoThumbnailTasks = async (): Promise<void> => {
    while (videoThumbnailTasksRef.current.size > 0) {
      await Promise.all([...videoThumbnailTasksRef.current.values()]);
    }
  };

  // Auto-save draft with debounce
  useEffect(() => {
    if (isSaving || !editorReady || manualSaveRef.current) return;

    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
    }

    const hasContent = !!(title.trim() || content.trim() || media.length > 0) || editorDirtyRef.current;
    if (hasContent) {
      draftSaveTimer.current = setTimeout(() => {
        void autoSaveDraftRef.current();
      }, 2000);
    }

    return () => {
      if (draftSaveTimer.current) {
        clearTimeout(draftSaveTimer.current);
      }
    };
  }, [title, content, date, media, tags, editorReady]);

  // Track unsaved changes
  useEffect(() => {
    if (isEditing) {
      const hasChanges =
        title !== initialTitle ||
        content !== initialContent ||
        date !== initialDate ||
        JSON.stringify(media) !== JSON.stringify(originalMedia) ||
        JSON.stringify(tags) !== JSON.stringify(initialTags) ||
        editorDirtyRef.current;
      setHasUnsavedChanges(hasChanges);
    } else {
      const hasContent = !!(title.trim() || content.trim() || media.length > 0) || editorDirtyRef.current;
      setHasUnsavedChanges(hasContent);
    }
  }, [title, content, date, media, tags, originalMedia, initialTitle, initialContent, initialDate, initialTags, isEditing]);

  // Listen for navigation events to detect back gesture/button
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (isSaving || !hasUnsavedChanges) {
        return;
      }

      e.preventDefault();

      setPendingNavigation(() => () => {
        navigation.dispatch(e.data.action);
      });

      setUnsavedDialogVisible(true);
    });

    return unsubscribe;
  }, [navigation, hasUnsavedChanges, isSaving]);

  const checkDraft = async (compareWith?: { title: string; content: string; date: string; media: MediaItem[]; tags: Tag[] }) => {
    try {
      const draftId = getDraftId(diaryId);
      const draft = await getDraft(draftId);
      if (!draft) return;

      if (compareWith) {
        const isIdentical =
          draft.title === compareWith.title &&
          draft.content === compareWith.content &&
          draft.date === compareWith.date &&
          JSON.stringify(draft.media) === JSON.stringify(compareWith.media) &&
          JSON.stringify(draft.tags) === JSON.stringify(compareWith.tags);

        if (isIdentical) {
          await deleteDraft(draftId);
          return;
        }
      }

      setDraftData(draft);
      setDraftDialogVisible(true);
    } catch (error) {
      console.error('Failed to check draft:', error);
    }
  };

  const clearDraftSaveSchedule = () => {
    if (draftSaveTimer.current) {
      clearTimeout(draftSaveTimer.current);
      draftSaveTimer.current = null;
    }
    autoSavePendingRef.current = false;
  };

  const getPersistedMedia = (markup: string, candidates: MediaItem[]): MediaItem[] => {
    const referencedIds = collectMediaIds(markup);
    return candidates.filter(
      (item) => !editorMediaIdsRef.current.has(item.id) || referencedIds.has(item.id),
    );
  };

  const getCurrentMedia = (): MediaItem[] =>
    mediaRef.current.map((item) => {
      const staged = stagedMediaRef.current.find((candidate) => candidate.id === item.id);
      if (staged) return staged;
      const generatedThumbnail = generatedThumbnailDerivativesRef.current.get(item.id);
      return generatedThumbnail && !item.thumbnail
        ? { ...item, thumbnail: generatedThumbnail }
        : item;
    });

  const autoSaveDraft = async () => {
    if (manualSaveRef.current) return;
    if (autoSaveInFlightRef.current) {
      autoSavePendingRef.current = true;
      return;
    }
    const task = (async () => {
      try {
        const draftId = getDraftId(diaryId);
        await flushVideoThumbnailTasks();
        const editorMarkup = editorRef.current ? await editorRef.current.getMarkup() : content;
        const persistedMedia = getPersistedMedia(editorMarkup, getCurrentMedia());
        setContentLength(extractPlainText(editorMarkup).length);

        const hasChanges = isEditing
          ? title !== initialTitle ||
            editorDirtyRef.current ||
            editorMarkup !== initialContent ||
            date !== initialDate ||
            JSON.stringify(persistedMedia) !== JSON.stringify(originalMedia) ||
            JSON.stringify(tags) !== JSON.stringify(initialTags)
          : !!(title.trim() || editorMarkup.trim() || persistedMedia.length > 0);

        if (!hasChanges) return;

        await saveDraft({
          id: draftId,
          diaryId: diaryId || null,
          title,
          content: editorMarkup,
          date,
          media: persistedMedia,
          tags,
          updatedAt: Date.now(),
        });
      } catch (error) {
        console.error('Failed to auto-save draft:', error);
      }
    })();
    autoSaveInFlightRef.current = task;
    try {
      await task;
    } finally {
      autoSaveInFlightRef.current = null;
      if (autoSavePendingRef.current && !manualSaveRef.current) {
        autoSavePendingRef.current = false;
        scheduleEditorDraftSave();
      } else if (manualSaveRef.current) {
        autoSavePendingRef.current = false;
      }
    }
  };
  autoSaveDraftRef.current = autoSaveDraft;

  const scheduleEditorDraftSave = () => {
    if (isSaving || manualSaveRef.current) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      void autoSaveDraftRef.current();
    }, 2000);
  };

  const restoreDraft = () => {
    if (!draftData) return;
    if (draftData.content !== content) {
    setEditorReady(false);
    editorMediaIdsRef.current = collectMediaIds(draftData.content);
    }
    setTitle(draftData.title);
    setContent(draftData.content);
    setContentLength(extractPlainText(draftData.content).length);
    setDate(draftData.date);
    setMedia(draftData.media);
    for (const item of draftData.media) {
      if (item.type === 'video' && !item.thumbnail) void startVideoThumbnailTask(item);
    }
    setTags(draftData.tags);
    editorDirtyRef.current = true;
    setHasUnsavedChanges(true);
    setDraftDialogVisible(false);
  };

  const cleanupStagedMediaAfterCancel = async (): Promise<void> => {
    // Include a thumbnail that finished while the cancel dialog was open.
    await flushVideoThumbnailTasks();
    const staged = stagedMediaRef.current;
    stagedMediaRef.current = [];
    for (const item of staged) {
      await deleteMedia(item.uri);
      if (item.thumbnail) await deleteMedia(item.thumbnail);
    }
    const derivatives = [...generatedThumbnailDerivativesRef.current.values()];
    generatedThumbnailDerivativesRef.current.clear();
    for (const thumbnail of derivatives) await deleteMedia(thumbnail);
  };

  const discardDraft = async () => {
    try {
      const draftId = getDraftId(diaryId);
      const discardedMedia = draftData?.media ?? [];
      await deleteDraft(draftId);
      // This is only the initial "discard found draft" action. Do not touch
      // the current editor session's staged media or thumbnail backfill.
      for (const item of discardedMedia) {
        try {
          if (!(await isMediaReferenced(item))) {
            await deleteMedia(item.uri);
            if (item.thumbnail) await deleteMedia(item.thumbnail);
          }
        } catch (error) {
          // Draft cleanup is best-effort and must not prevent editing.
          console.warn('Failed to clean discarded draft media:', error);
        }
      }
    } catch (error) {
      console.error('Failed to delete draft:', error);
    }
    setDraftDialogVisible(false);
  };

  const loadDiary = async (id: string) => {
    try {
      const diary = await getDiaryById(id);
      if (diary) {
        editorDirtyRef.current = false;
        setTitle(diary.title);
        setContent(diary.content);
        setContentLength(extractPlainText(diary.content).length);
        setDate(formatDateInputValue(diary.createdAt));
        setInitialCreatedAt(diary.createdAt);
        const orderedMedia = assignMediaPositions(getOrderedMedia(diary.media));
        setMedia(orderedMedia);
        originalMediaRef.current = orderedMedia;
        setOriginalMedia(orderedMedia);
        setTags(diary.tags);
        setInitialTitle(diary.title);
        setInitialContent(diary.content);
        setInitialDate(formatDateInputValue(diary.createdAt));
        setInitialTags(diary.tags);
        editorMediaIdsRef.current = collectMediaIds(diary.content);
        setEntryLoaded(true);

        // Upgrade historical videos without staging or deleting their source.
        for (const item of orderedMedia) {
          if (item.type === 'video' && !item.thumbnail) void startVideoThumbnailTask(item);
        }

        await checkDraft({
          title: diary.title,
          content: diary.content,
          date: formatDateInputValue(diary.createdAt),
          media: orderedMedia,
          tags: diary.tags,
        });
      } else {
        setNotFoundDialogVisible(true);
      }
    } catch (error) {
      console.error('Failed to load diary:', error);
      setLoadErrorDialogVisible(true);
    }
  };

  const pickMedia = async (mediaType: 'image' | 'video') => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      setLibraryPermissionDialogVisible(true);
      return;
    }

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: mediaType === 'image' ? ['images'] : ['videos'],
        allowsMultipleSelection: true,
        orderedSelection: true,
        quality: 1,
      });

      if (!result.canceled) {
        for (const asset of result.assets) {
          try {
            const id = generateId();
            const item: MediaItem = {
              id,
              type: mediaType,
              uri: asset.uri,
              fileName: asset.fileName,
              mimeType: asset.mimeType,
            };
            const savedUri = await saveMedia(asset.uri, `${id}.${getMediaFileExtension(item)}`);
            const savedItem = { ...item, uri: savedUri };
            stagedMediaRef.current.push(savedItem);
            setMedia((current) => assignMediaPositions([...current, savedItem]));
            if (savedItem.type === 'video') void startVideoThumbnailTask(savedItem);
            if (editorReady && editorRef.current) {
              editorMediaIdsRef.current.add(item.id);
              if (item.type === 'video') editorRef.current.insertVideo(item.id);
              else editorRef.current.insertImage(item.id);
            }
          } catch (error) {
            console.warn(`Failed to stage ${mediaType}:`, error);
          }
        }
      }
    } catch (error) {
      console.error(`Failed to pick ${mediaType}:`, error);
    }
  };

  const pickImage = () => pickMedia('image');
  const pickVideo = () => pickMedia('video');

  const handleAudioRecorded = async (uri: string) => {
    try {
      const id = generateId();
      const newAudio: MediaItem = {
        id,
        type: 'audio',
        uri,
        mimeType: 'audio/mp4',
      };
      const savedUri = await saveMedia(uri, `${id}.m4a`);
      const savedAudio = { ...newAudio, uri: savedUri };
      stagedMediaRef.current.push(savedAudio);
      setMedia((current) => assignMediaPositions([...current, savedAudio]));
      if (editorReady && editorRef.current) {
        editorMediaIdsRef.current.add(savedAudio.id);
        editorRef.current.insertAudio(savedAudio.id);
      }
    } catch (error) {
      console.error('Failed to stage recorded audio:', error);
    }
  };

  const handleSave = async (skipNavigation?: boolean) => {
    if (!editorReady || manualSaveRef.current) return false;
    manualSaveRef.current = true;
    clearDraftSaveSchedule();

    let editorMarkup = content;
    let saveSucceeded = false;
    try {
      await flushVideoThumbnailTasks();
      editorMarkup = editorRef.current ? await editorRef.current.getMarkup() : content;
      const currentMedia = getCurrentMedia();
      const persistedMedia = getPersistedMedia(editorMarkup, currentMedia);
      if (!title.trim() && !editorMarkup.trim() && persistedMedia.length === 0) {
        setEmptyContentDialogVisible(true);
        return false;
      }

      setLoading(true);
      setIsSaving(true);
      const parsedCreatedAt = parseDateInputValue(
        date,
        isEditing ? initialCreatedAt : Date.now()
      );

      if (parsedCreatedAt === null) {
        setInvalidDateDialogVisible(true);
        setLoading(false);
        setIsSaving(false);
        return false;
      }

      const savedMedia: MediaItem[] = [];
      const removedMedia = isEditing
        ? originalMedia.filter((om) => !persistedMedia.some((sm) => sm.id === om.id))
        : [];
      for (const item of assignMediaPositions(persistedMedia)) {
        const isInOurStorage = item.uri.startsWith(MEDIA_DIR_PATH);
        const isOriginal = originalMedia.some((m) => m.id === item.id);

        if (isInOurStorage) {
          savedMedia.push(item);
        } else if (isOriginal) {
          savedMedia.push(item);
        } else {
          const fileName = `${generateId()}.${getMediaFileExtension(item)}`;
          const savedUri = await saveMedia(item.uri, fileName);
          const savedItem = { ...item, uri: savedUri };
          savedMedia.push(savedItem);
        }
      }

      const now = Date.now();
      const entry: DiaryEntry = {
        id: diaryId || generateId(),
        title: title.trim(),
        content: editorMarkup.trim(),
        media: savedMedia,
        tags: tags,
        createdAt: parsedCreatedAt,
        updatedAt: now,
      };

      if (isEditing) {
        await updateDiary(entry);
      } else {
        await createDiary(entry);
      }

      // Delete draft after successful save
      const draftId = getDraftId(diaryId);
      if (autoSaveInFlightRef.current) {
        await autoSaveInFlightRef.current;
      }
      clearDraftSaveSchedule();
      await deleteDraft(draftId);
      saveSucceeded = true;

      const cleanupCandidates = selectPostCommitCleanupCandidates(
        [...removedMedia, ...stagedMediaRef.current],
        persistedMedia,
      );
      for (const item of cleanupCandidates) {
        try {
          if (!(await isMediaReferenced(item))) {
            await deleteMedia(item.uri);
            if (item.thumbnail) await deleteMedia(item.thumbnail);
          }
        } catch (error) {
          console.warn('Failed to post-commit media cleanup:', error);
        }
      }

      setHasUnsavedChanges(false);
      setIsSaving(false);
      if (isEditing) {
        setInitialTitle(title.trim());
        setInitialContent(editorMarkup.trim());
        setInitialDate(date);
        setInitialTags(tags);
        setOriginalMedia(savedMedia);
        setInitialCreatedAt(parsedCreatedAt);
      }
      originalMediaRef.current = savedMedia;

      editorDirtyRef.current = false;
      editorMediaIdsRef.current = collectMediaIds(editorMarkup);
      setMedia(savedMedia);
      setContentLength(extractPlainText(editorMarkup).length);
      setContent(editorMarkup);

      if (!skipNavigation) {
        navigation.goBack();
      }
      stagedMediaRef.current = [];
      // Existing-media derivatives are now persisted in the committed row.
      generatedThumbnailDerivativesRef.current.clear();
      return true;
    } catch (error) {
      console.error('Failed to save diary:', error);
      setSaveErrorDialogVisible(true);
      return false;
    } finally {
      const shouldResumeDraft = !saveSucceeded && (
        editorDirtyRef.current ||
        title !== initialTitle ||
        content !== initialContent ||
        date !== initialDate ||
        JSON.stringify(media) !== JSON.stringify(originalMedia) ||
        JSON.stringify(tags) !== JSON.stringify(initialTags)
      );
      clearDraftSaveSchedule();
      manualSaveRef.current = false;
      setLoading(false);
      setIsSaving(false);
      if (shouldResumeDraft) {
        scheduleEditorDraftSave();
      }
    }
  };

  const handleDateConfirm = (selectedDate: Date) => {
    setDate(formatDateInputValue(selectedDate.getTime()));
    setShowDatePicker(false);
  };

  const dateObj = parseDateInputValue(date)
    ? new Date(parseDateInputValue(date)!)
    : new Date();
  const shouldShowEditorToolbar = editorReady && !editorLoadError && keyboardPhase === 'visible';
  useEffect(() => {
    recordLifecycleEvent(
      'toolbar-render-decision',
      `show=${shouldShowEditorToolbar ? 1 : 0}|phase=${keyboardPhase}|owner=${editorInputOwnerRef.current ?? 'none'}|positive=${keyboardPositiveEvidenceRef.current ? 1 : 0}`,
    );
  }, [keyboardPhase, recordLifecycleEvent, shouldShowEditorToolbar]);

  return (
    <SafeAreaView style={styles.mainContainer} edges={['top']}>
      <KeyboardAvoidingView
        ref={keyboardAvoidingViewRef}
        style={styles.keyboardView}
        // Expo Go on the target device reports keyboard visibility without
        // resizing the root (pan/overlay). Let KAV provide the missing height
        // boundary so the normal toolbar sibling remains above the IME.
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={keyboardAvoidingOffsetRef.current}
        enabled
        onLayout={(event) => {
          const { x, y, width, height } = event.nativeEvent.layout;
          kavFrameRef.current = { x, y, width, height };
          recordLifecycleEvent('kav-layout', `${Math.round(width)}x${Math.round(height)}`);
        }}
      >
        <View
          ref={editorRootRef}
          style={styles.contentContainer}
          onLayout={(event) => {
            const { x, y, width, height } = event.nativeEvent.layout;
            editorRootFrameRef.current = { x, y, width, height };
            recordLifecycleEvent('root-layout', `${Math.round(width)}x${Math.round(height)}`);
            handleEditorRootLayout(height);
          }}
        >
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.headerButton}
              onPress={() => navigation.goBack()}
            >
              <Text style={styles.cancelText}>取消</Text>
            </TouchableOpacity>
            <Text style={styles.headerTitle}>
              {isEditing ? '编辑日记' : '写日记'}
            </Text>
            <TouchableOpacity
              style={[styles.headerButton, styles.saveButton]}
              onPress={() => handleSave()}
              disabled={loading || !editorReady}
            >
              <Text style={[styles.saveText, (loading || !editorReady) && styles.disabledText]}>
                {loading ? '保存中...' : editorReady ? '保存' : '编辑器加载中...'}
              </Text>
            </TouchableOpacity>
            {__DEV__ && KEYBOARD_TRACE_ENABLED && (
              <TouchableOpacity
                accessibilityLabel="打开键盘诊断日志"
                onPress={openKeyboardTrace}
                style={styles.keyboardTraceEntry}
              >
                <Text style={styles.keyboardTraceEntryText}>Trace</Text>
              </TouchableOpacity>
            )}
          </View>

          <ScrollView
            ref={editorScrollRef}
            style={styles.mediaScroll}
            contentContainerStyle={styles.scrollContentContainer}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onLayout={(event) => {
              const { x, y, width, height } = event.nativeEvent.layout;
              scrollFrameRef.current = { x, y, width, height };
              scrollViewportHeightRef.current = height;
              recordLifecycleEvent('scroll-layout', `${Math.round(width)}x${Math.round(height)}`);
              scheduleReveal();
            }}
            onContentSizeChange={(_, height) => {
              scrollContentHeightRef.current = height;
              recordLifecycleEvent('scroll-content', `${Math.round(height)}`);
              scheduleReveal();
            }}
            onScrollBeginDrag={() => {
              recordLifecycleEvent('scroll-begin-drag');
              manualScrollActiveRef.current = true;
              suppressRevealAfterManualScrollRef.current = true;
              pendingRevealRef.current = null;
              lastRevealCommandRef.current = null;
              if (caretEnsureFrameRef.current !== null) {
                cancelAnimationFrame(caretEnsureFrameRef.current);
                caretEnsureFrameRef.current = null;
              }
            }}
            onScrollEndDrag={() => {
              recordLifecycleEvent('scroll-end-drag');
              // Keep reveal suppressed until a new caret/focus/keyboard/tag
              // signal arrives. This prevents an old caret from reclaiming a
              // user scroll, including devices without momentum callbacks.
              manualScrollActiveRef.current = false;
              if (inputRevealRequestedRef.current) queueCaretRevealAfterInput();
            }}
            onMomentumScrollBegin={() => {
              recordLifecycleEvent('scroll-momentum-begin');
              manualScrollActiveRef.current = true;
            }}
            onMomentumScrollEnd={() => {
              recordLifecycleEvent('scroll-momentum-end');
              manualScrollActiveRef.current = false;
              if (inputRevealRequestedRef.current) queueCaretRevealAfterInput();
            }}
            onScroll={(event) => {
              const nextOffset = event.nativeEvent.contentOffset.y;
              if (Math.abs(nextOffset - lastLoggedScrollOffsetRef.current) >= 4) {
                recordLifecycleEvent('scroll-offset', `${Math.round(lastLoggedScrollOffsetRef.current)}->${Math.round(nextOffset)}`);
                lastLoggedScrollOffsetRef.current = nextOffset;
              }
              scrollOffsetRef.current = nextOffset;
              if (!manualScrollActiveRef.current && !suppressRevealAfterManualScrollRef.current) {
                scheduleReveal();
              }
            }}
          >
            {/* Date selector */}
            <View style={styles.dateRow}>
              <TouchableOpacity
                onPress={() => setShowDatePicker(true)}
                activeOpacity={0.7}
              >
                <Text style={styles.dateText}>
                  {date} {getWeekDayLabel(date)}
                </Text>
              </TouchableOpacity>
              <Text style={styles.charCount}>{contentLength} 字</Text>
            </View>

            {/* Title & Content area */}
            <View
              style={styles.editorArea}
              onLayout={(event) => {
                editorAreaTopRef.current = event.nativeEvent.layout.y;
              }}
            >
              <TextInput
                style={styles.titleInput}
                placeholder="标题（选填）"
                placeholderTextColor="#c4b8ae"
                value={title}
                onChangeText={setTitle}
                onFocus={() => handleNonEditorFocusChange(true)}
                maxLength={100}
                scrollEnabled={false}
                autoCorrect={false}
                autoCapitalize="none"
                importantForAutofill="no"
                multiline={false}
                numberOfLines={1}
              />
              <View style={styles.divider} />
              {entryLoaded && !editorLoadError ? (
                <View
                onLayout={(event) => {
                  editorHostTopRef.current = event.nativeEvent.layout.y;
                  scheduleReveal();
                }}
              >
                  <RichEditorHost
                    key={editorMountKey}
                    ref={editorRef}
                    initialMarkup={content}
                    showToolbar={false}
                    onStateChange={(state) => {
                      recordLifecycleEvent('state', `focus=${state.isFocused ? 1 : 0}|caret=${state.caretRect ? `${Math.round(state.caretRect.top)}..${Math.round(state.caretRect.bottom)}` : 'null'}`);
                      setEditorActiveState(state);
                      // A delayed false snapshot can follow the native/WebView
                      // touch event. Only a positive editor snapshot may claim
                      // ownership; title/tag focus explicitly revokes it.
                      if (state.isFocused && editorInputOwnerRef.current !== 'other') {
                        handleEditorFocusChange(true);
                      }
                      queueCaretReveal(state.caretRect);
                    }}
                    onFocusChange={handleEditorFocusChange}
                    onInteraction={() => {
                      explicitCaretRevealRequestedRef.current = true;
                    }}
                    onReady={(adapter) => {
                      editorRef.current = adapter;
                      const state = adapter.getActiveState();
                      setEditorActiveState(state);
                      if (state.isFocused) handleEditorFocusChange(true);
                      queueCaretReveal(state.caretRect);
                      setEditorLoadError(null);
                      setEditorReady(true);
                    }}
                    onDirty={() => {
                      inputRevealRequestedRef.current = true;
                      recordLifecycleEvent('dirty');
                      if (!editorDirtyRef.current) {
                        editorDirtyRef.current = true;
                        setHasUnsavedChanges(true);
                      }
                      scheduleEditorDraftSave();
                    }}
                  />
                </View>
              ) : editorLoadError ? (
                <View style={styles.editorLoading}>
                  <Text style={styles.editorLoadingText}>{editorLoadError}</Text>
                  <TouchableOpacity style={styles.editorRetryButton} onPress={retryEditor}>
                    <Text style={styles.editorRetryText}>重试</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.editorLoading}>
                  <Text style={styles.editorLoadingText}>编辑器加载中...</Text>
                </View>
              )}
            </View>

            {/* Media section */}
            <View style={styles.mediaSection}>
              <View style={styles.mediaButtonRow}>
                <TouchableOpacity
                  onPress={pickImage}
                  activeOpacity={0.7}
                  style={[styles.mediaButtonFlex, !editorReady && styles.mediaButtonDisabled]}
                  disabled={!editorReady}
                  accessibilityState={{ disabled: !editorReady }}
                >
                  <Text style={styles.mediaLabel}>图片</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={pickVideo}
                  activeOpacity={0.7}
                  style={[styles.mediaButtonFlex, !editorReady && styles.mediaButtonDisabled]}
                  disabled={!editorReady}
                  accessibilityState={{ disabled: !editorReady }}
                >
                  <Text style={styles.mediaLabel}>视频</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setShowAudioRecorder(true)}
                  activeOpacity={0.7}
                  style={[styles.mediaButtonFlex, !editorReady && styles.mediaButtonDisabled]}
                  disabled={!editorReady}
                  accessibilityState={{ disabled: !editorReady }}
                >
                  <Text style={styles.mediaLabel}>录音</Text>
                </TouchableOpacity>
              </View>
              <MediaPicker
                media={media.filter((item) => !editorMediaIdsRef.current.has(item.id))}
                onMediaChange={(nextMedia) => {
                  const bodyMedia = media.filter((item) => editorMediaIdsRef.current.has(item.id));
                  setMedia(assignMediaPositions([...bodyMedia, ...nextMedia]));
                }}
              />
            </View>

            <View
              onLayout={(event) => {
                tagEditorTopRef.current = event.nativeEvent.layout.y;
                if (tagInputFocusedRef.current) revealTagInput();
              }}
            >
              <TagEditor
                selectedTags={tags}
                onTagsChange={setTags}
                onInputLayout={(bottomWithinTagEditor) => {
                  tagInputBottomRef.current = bottomWithinTagEditor;
                  if (tagInputFocusedRef.current) revealTagInput();
                }}
                onInputFocus={(focused) => {
                  tagInputFocusedRef.current = focused;
                  handleNonEditorFocusChange(focused);
                  if (focused) revealTagInput();
                }}
              />
            </View>

            <View style={styles.bottomPadding} />
          </ScrollView>
          {shouldShowEditorToolbar && (
            <View
              ref={keyboardToolbarRef}
              style={styles.keyboardToolbar}
              onLayout={(event) => {
                const height = event.nativeEvent.layout.height;
                toolbarFrameRef.current = {
                  x: event.nativeEvent.layout.x,
                  y: event.nativeEvent.layout.y,
                  width: event.nativeEvent.layout.width,
                  height,
                };
                recordLifecycleEvent('toolbar-layout', `${Math.round(event.nativeEvent.layout.width)}x${Math.round(height)}`);
                if (height !== keyboardToolbarHeightRef.current) {
                  keyboardToolbarHeightRef.current = height;
                  scheduleReveal();
                }
              }}
            >
              <RichEditorToolbar adapter={editorRef.current} state={editorActiveState} />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>

      {__DEV__ && KEYBOARD_TRACE_ENABLED && (
        <Modal
          visible={debugKeyboardTraceVisible}
          transparent
          animationType="fade"
          onRequestClose={() => {
            debugKeyboardTraceVisibleRef.current = false;
            setDebugKeyboardTraceVisible(false);
          }}
        >
          <View style={styles.keyboardTraceModalBackdrop}>
            <View style={styles.keyboardTraceCard}>
              <View style={styles.keyboardTraceHeader}>
                <Text style={styles.keyboardTraceTitle}>{debugKeyboardTraceTitle}</Text>
                <TouchableOpacity
                  accessibilityLabel="关闭键盘诊断"
                  onPress={() => {
                    debugKeyboardTraceVisibleRef.current = false;
                    setDebugKeyboardTraceVisible(false);
                  }}
                  style={styles.keyboardTraceClose}
                >
                  <Text style={styles.keyboardTraceCloseText}>关闭</Text>
                </TouchableOpacity>
              </View>
              <ScrollView
                style={styles.keyboardTraceScroll}
                nestedScrollEnabled
                showsVerticalScrollIndicator
              >
                <Text selectable style={styles.keyboardTraceText}>{debugKeyboardTrace ?? getDebugTraceSnapshot(false)}</Text>
              </ScrollView>
              {debugKeyboardTraceError && (
                <Text style={styles.keyboardTraceError}>{debugKeyboardTraceError}</Text>
              )}
              <View style={styles.keyboardTraceActions}>
                <TouchableOpacity onPress={clearKeyboardTrace} style={styles.keyboardTraceAction}>
                  <Text style={styles.keyboardTraceActionText}>清空</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={shareKeyboardTrace} style={styles.keyboardTraceAction}>
                  <Text style={styles.keyboardTraceActionText}>分享</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    debugKeyboardTraceVisibleRef.current = false;
                    setDebugKeyboardTraceVisible(false);
                  }}
                  style={styles.keyboardTraceAction}
                >
                  <Text style={styles.keyboardTraceActionText}>关闭</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      {/* Draft restore dialog */}
      <StyledDialog
        visible={draftDialogVisible}
        title="发现草稿"
        message="检测到未保存的草稿，是否恢复？"
        buttons={[
          {
            text: '丢弃',
            style: 'destructive',
            onPress: discardDraft,
          },
          {
            text: '恢复',
            style: 'default',
            onPress: restoreDraft,
          },
        ]}
        onDismiss={() => setDraftDialogVisible(false)}
      />

      {/* Not found dialog */}
      <StyledDialog
        visible={notFoundDialogVisible}
        title="提示"
        message="这篇日记不存在或已被删除"
        buttons={[{ text: '确定', style: 'default', onPress: () => {
          setNotFoundDialogVisible(false);
          navigation.goBack();
        } }]}
        onDismiss={() => {
          setNotFoundDialogVisible(false);
          navigation.goBack();
        }}
      />

      {/* Load error dialog */}
      <StyledDialog
        visible={loadErrorDialogVisible}
        title="错误"
        message="无法加载日记"
        buttons={[{ text: '确定', style: 'default', onPress: () => setLoadErrorDialogVisible(false) }]}
        onDismiss={() => setLoadErrorDialogVisible(false)}
      />

      {/* Empty content dialog */}
      <StyledDialog
        visible={emptyContentDialogVisible}
        title="提示"
        message="请填写日记内容"
        buttons={[{ text: '确定', style: 'default', onPress: () => setEmptyContentDialogVisible(false) }]}
        onDismiss={() => setEmptyContentDialogVisible(false)}
      />

      {/* Invalid date dialog */}
      <StyledDialog
        visible={invalidDateDialogVisible}
        title="提示"
        message="请输入有效日期，格式为 YYYY-MM-DD"
        buttons={[{ text: '确定', style: 'default', onPress: () => setInvalidDateDialogVisible(false) }]}
        onDismiss={() => setInvalidDateDialogVisible(false)}
      />

      {/* Save error dialog */}
      <StyledDialog
        visible={saveErrorDialogVisible}
        title="错误"
        message="保存失败"
        buttons={[{ text: '确定', style: 'default', onPress: () => setSaveErrorDialogVisible(false) }]}
        onDismiss={() => setSaveErrorDialogVisible(false)}
      />

      {/* Library permission dialog */}
      <StyledDialog
        visible={libraryPermissionDialogVisible}
        title="权限不足"
        message="需要访问相册权限才能选择图片或视频"
        buttons={[{ text: '确定', style: 'default', onPress: () => setLibraryPermissionDialogVisible(false) }]}
        onDismiss={() => setLibraryPermissionDialogVisible(false)}
      />

      {/* Unsaved changes dialog */}
      <StyledDialog
        visible={unsavedDialogVisible}
        title="有未保存的更改"
        message="确定要退出吗？退出后将丢失未保存的内容。"
        buttons={[
          { text: '取消', style: 'cancel', onPress: () => {
            setUnsavedDialogVisible(false);
            setPendingNavigation(null);
          }},
          { text: '不保存', style: 'destructive', onPress: async () => {
            setUnsavedDialogVisible(false);
            try {
              const draftId = getDraftId(diaryId);
              await deleteDraft(draftId);
              await cleanupStagedMediaAfterCancel();
            } catch (error) {
              console.error('Failed to delete draft on discard:', error);
            }
            // Reset unsaved changes BEFORE dispatching navigation to prevent
            // the beforeRemove listener from re-triggering the dialog loop (#12).
            setHasUnsavedChanges(false);
            if (pendingNavigation) {
              pendingNavigation();
              setPendingNavigation(null);
            }
          }},
          { text: '保存', style: 'default', onPress: async () => {
            setUnsavedDialogVisible(false);
            const success = await handleSave(true);
            if (success && pendingNavigation) {
              pendingNavigation();
              setPendingNavigation(null);
            }
          }},
        ]}
        onDismiss={() => {
          setUnsavedDialogVisible(false);
          setPendingNavigation(null);
        }}
      />

      <DatePickerModal
        visible={showDatePicker}
        date={dateObj}
        onConfirm={handleDateConfirm}
        onCancel={() => setShowDatePicker(false)}
      />

      {showAudioRecorder && (
        <AudioRecorder
          onClose={() => setShowAudioRecorder(false)}
          onRecorded={handleAudioRecorded}
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  mainContainer: {
    flex: 1,
    backgroundColor: PAPER_BG,
  },
  contentContainer: {
    flex: 1,
    position: 'relative',
  },
  mediaScroll: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    position: 'relative',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: PAPER_BG,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(196, 112, 48, 0.1)',
  },
  headerButton: {
    minWidth: 50,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: TEXT_PRIMARY,
    fontFamily: 'LXGWWenKaiLite',
  },
  cancelText: {
    fontSize: 16,
    color: TEXT_SECONDARY,
    fontFamily: 'LXGWWenKaiLite',
  },
  saveButton: {
    alignItems: 'flex-end',
  },
  saveText: {
    fontSize: 16,
    color: BRAND_GOLD,
    fontWeight: '600',
    fontFamily: 'LXGWWenKaiLite',
  },
  disabledText: {
    color: '#c4b8ae',
  },
  scrollContentContainer: {
    paddingBottom: 100,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: PAPER_BG,
    marginTop: 8,
  },
  dateText: {
    fontSize: 15,
    color: BRAND_GOLD,
    fontWeight: '500',
    fontFamily: 'LXGWWenKaiLite',
  },
  charCount: {
    fontSize: 12,
    color: TEXT_MUTED,
    fontFamily: 'LXGWWenKaiLite',
  },
  editorArea: {
    paddingTop: 8,
    paddingHorizontal: 0,
    paddingBottom: 0,
    backgroundColor: PAPER_BG,
  },
  titleInput: {
    fontSize: 22,
    fontWeight: '600',
    color: TEXT_PRIMARY,
    paddingVertical: 0,
    paddingHorizontal: 18,
    borderWidth: 0,
    backgroundColor: 'transparent',
    height: 40,
    fontFamily: 'LXGWWenKaiLite',
    letterSpacing: 0.5,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(196, 112, 48, 0.15)',
    marginVertical: 12,
  },
  editorLoading: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editorLoadingText: {
    fontSize: 15,
    color: TEXT_MUTED,
    fontFamily: 'LXGWWenKaiLite',
  },
  editorRetryButton: {
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(196, 112, 48, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(196, 112, 48, 0.2)',
  },
  editorRetryText: {
    fontSize: 14,
    color: BRAND_GOLD,
    fontFamily: 'LXGWWenKaiLite',
  },
  contentInput: {
    fontSize: 17,
    color: TEXT_PRIMARY,
    lineHeight: 30,
    paddingVertical: 8,
    paddingHorizontal: 4,
    minHeight: 120,
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'LXGWWenKaiLite',
    letterSpacing: 0.3,
  },
  mediaSection: {
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  mediaButtonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  mediaButtonFlex: {
    flex: 1,
  },
  mediaButtonDisabled: {
    opacity: 0.45,
  },
  mediaLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: BRAND_GOLD,
    marginBottom: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(196, 112, 48, 0.08)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(196, 112, 48, 0.15)',
    overflow: 'hidden',
    textAlign: 'center',
    fontFamily: 'LXGWWenKaiLite',
  },
  bottomPadding: {
    height: 40,
  },
  keyboardToolbar: {
    flexShrink: 0,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 6,
    backgroundColor: PAPER_BG,
    borderTopWidth: 1,
    borderTopColor: 'rgba(196, 112, 48, 0.12)',
  },
  keyboardTraceEntry: {
    position: 'absolute',
    right: 68,
    top: 8,
    minWidth: 50,
    alignItems: 'flex-end',
    paddingVertical: 4,
  },
  keyboardTraceEntryText: {
    color: BRAND_GOLD,
    fontSize: 12,
    fontWeight: '600',
  },
  keyboardTraceModalBackdrop: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.28)',
  },
  keyboardTraceCard: {
    height: '52%',
    maxHeight: '52%',
    backgroundColor: 'rgba(35, 27, 22, 0.94)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  keyboardTraceHeader: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.18)',
  },
  keyboardTraceTitle: {
    color: '#fff5e8',
    fontSize: 11,
    fontWeight: '700',
  },
  keyboardTraceClose: {
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  keyboardTraceCloseText: {
    color: '#ffd7a8',
    fontSize: 12,
  },
  keyboardTraceScroll: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  keyboardTraceText: {
    color: '#fff5e8',
    fontSize: 10,
    lineHeight: 15,
    fontFamily: 'monospace',
  },
  keyboardTraceError: {
    color: '#ffb4a8',
    fontSize: 11,
    paddingHorizontal: 10,
    paddingBottom: 6,
  },
  keyboardTraceActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.18)',
  },
  keyboardTraceAction: {
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  keyboardTraceActionText: {
    color: '#ffd7a8',
    fontSize: 12,
    fontWeight: '600',
  },
});
