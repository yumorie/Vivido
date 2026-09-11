import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
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
import { collectMediaIds, extractPlainText, RichEditorAdapter, RichEditorHost } from '../editor';
import { selectPostCommitCleanupCandidates } from '../editor/mediaLifecycle';

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Editor'>;
type EditorRouteProp = RouteProp<RootStackParamList, 'Editor'>;

const PAPER_BG = '#f5f0e6';
const TEXT_PRIMARY = '#3d2c1e';
const TEXT_SECONDARY = '#7a6250';
const TEXT_MUTED = '#a48a74';
const BRAND_GOLD = '#c47030';

const getDraftId = (diaryId?: string): string => diaryId || 'new';

export const EditorScreen: React.FC = () => {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<EditorRouteProp>();
  const diaryId = route.params?.diaryId;
  const isEditing = !!diaryId;

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [date, setDate] = useState(formatDateInputValue(Date.now()));
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
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

  useEffect(() => {
    if (!entryLoaded || editorReady || editorLoadError) return;

    const timeout = setTimeout(() => {
      setEditorLoadError('编辑器加载超时，请重试');
    }, 9000);

    return () => clearTimeout(timeout);
  }, [entryLoaded, editorReady, editorLoadError, editorMountKey]);

  const retryEditor = () => {
    editorRef.current = null;
    setEditorReady(false);
    setEditorLoadError(null);
    setEditorMountKey((current) => current + 1);
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

  const autoSaveDraft = async () => {
    if (manualSaveRef.current) return;
    if (autoSaveInFlightRef.current) {
      autoSavePendingRef.current = true;
      return;
    }
    const task = (async () => {
      try {
        const draftId = getDraftId(diaryId);
        const editorMarkup = editorRef.current ? await editorRef.current.getMarkup() : content;
        const persistedMedia = getPersistedMedia(editorMarkup, media);
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
    setTags(draftData.tags);
    editorDirtyRef.current = true;
    setHasUnsavedChanges(true);
    setDraftDialogVisible(false);
  };

  const discardDraft = async () => {
    try {
      const draftId = getDraftId(diaryId);
      await deleteDraft(draftId);
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
        setOriginalMedia(orderedMedia);
        setTags(diary.tags);
        setInitialTitle(diary.title);
        setInitialContent(diary.content);
        setInitialDate(formatDateInputValue(diary.createdAt));
        setInitialTags(diary.tags);
        editorMediaIdsRef.current = collectMediaIds(diary.content);
        setEntryLoaded(true);

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
      editorMarkup = editorRef.current ? await editorRef.current.getMarkup() : content;
      const persistedMedia = getPersistedMedia(editorMarkup, media);
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

      editorDirtyRef.current = false;
      editorMediaIdsRef.current = collectMediaIds(editorMarkup);
      setMedia(savedMedia);
      setContentLength(extractPlainText(editorMarkup).length);
      setContent(editorMarkup);

      if (!skipNavigation) {
        navigation.goBack();
      }
      stagedMediaRef.current = [];
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

  return (
    <SafeAreaView style={styles.mainContainer} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
        enabled
      >
        <View style={styles.contentContainer}>
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
          </View>

          <ScrollView
            style={styles.mediaScroll}
            contentContainerStyle={styles.scrollContentContainer}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
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
            <View style={styles.editorArea}>
              <TextInput
                style={styles.titleInput}
                placeholder="标题（选填）"
                placeholderTextColor="#c4b8ae"
                value={title}
                onChangeText={setTitle}
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
                <RichEditorHost
                  key={editorMountKey}
                  ref={editorRef}
                  initialMarkup={content}
                  onReady={(adapter) => {
                    editorRef.current = adapter;
                    setEditorLoadError(null);
                    setEditorReady(true);
                  }}
                  onDirty={() => {
                    if (!editorDirtyRef.current) {
                      editorDirtyRef.current = true;
                      setHasUnsavedChanges(true);
                    }
                    scheduleEditorDraftSave();
                  }}
                />
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

            <TagEditor
              selectedTags={tags}
              onTagsChange={setTags}
            />

            <View style={styles.bottomPadding} />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>

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
    paddingBottom: 32,
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
    marginHorizontal: 16,
    padding: 20,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(196, 112, 48, 0.12)',
  },
  titleInput: {
    fontSize: 22,
    fontWeight: '600',
    color: TEXT_PRIMARY,
    paddingVertical: 0,
    paddingHorizontal: 4,
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
    minHeight: 220,
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
    minHeight: 220,
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
});
