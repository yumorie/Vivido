import { Node, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { BridgeExtension } from '@10play/tentap-editor/web';
import type {
  VividoMediaAction,
  VividoMediaEditorInstance,
  VividoMediaPreview,
  VividoMediaType,
} from '../VividoMediaBridge';
import { VIVIDO_MEDIA_BRIDGE_NAME } from '../VividoMediaContract';

const mediaIdPattern = /^[A-Za-z0-9._~-]+$/;

const createMediaNode = (mediaType: VividoMediaType) =>
  Node.create({
    name: `vivido${mediaType[0].toUpperCase()}${mediaType.slice(1)}`,
    group: 'block',
    atom: true,
    selectable: true,
    isolating: true,
    content: '',
    addAttributes() {
      const attributes: Record<string, unknown> = {
        mediaId: {
          default: null,
          parseHTML: (element: HTMLElement) => {
            const value = element.getAttribute('data-vivido-media-id');
            return value && mediaIdPattern.test(value) ? value : null;
          },
          renderHTML: (value: { mediaId?: string | null }) =>
            value.mediaId && mediaIdPattern.test(value.mediaId)
              ? { 'data-vivido-media-id': value.mediaId }
              : {},
        },
      };
      if (mediaType === 'image') {
        attributes.alt = {
          default: '',
          parseHTML: (element: HTMLElement) => element.getAttribute('data-vivido-media-alt') ?? '',
          renderHTML: (value: { alt?: string }) => ({
            'data-vivido-media-alt': value.alt ?? '',
          }),
        };
      }
      return attributes;
    },
    parseHTML() {
      return [
        {
          tag: `div[data-vivido-media-type="${mediaType}"]`,
          getAttrs: (element: HTMLElement) => {
            const mediaId = element.getAttribute('data-vivido-media-id');
            if (!mediaId || !mediaIdPattern.test(mediaId)) return false;
            if (mediaType !== 'image' && element.hasAttribute('data-vivido-media-alt')) return false;
            return mediaType === 'image'
              ? { mediaId, alt: element.getAttribute('data-vivido-media-alt') ?? '' }
              : { mediaId };
          },
        },
      ];
    },
    renderHTML({ HTMLAttributes }) {
      const label = mediaType === 'image' ? '图片' : mediaType === 'audio' ? '录音' : '视频';
      return [
        'div',
        mergeAttributes(HTMLAttributes, {
          'data-vivido-media-type': mediaType,
          'data-vivido-media-label': label,
          class: `vivido-media vivido-media-${mediaType}`,
        }),
      ];
    },
  });

const imageNode = createMediaNode('image');
const audioNode = createMediaNode('audio');
const videoNode = createMediaNode('video');

const previewUriPattern = /^(?:file|content):\/\//i;
let previewCache: VividoMediaPreview[] = [];
let previewObserver: MutationObserver | null = null;
let previewObserverTarget: Element | null = null;
let previewRefreshQueued = false;

const isSafePreviewUri = (uri: string | undefined): uri is string =>
  Boolean(uri && previewUriPattern.test(uri) && !/^data:/i.test(uri));

const syncNaturalImageSize = (image: HTMLImageElement) => {
  const apply = () => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      image.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
      image.style.height = 'auto';
    }
  };
  image.addEventListener('load', apply, { once: true });
  apply();
};

/** Read-only caret geometry for the native outer-scroll visibility helper. */
const readCaretRect = () => {
  const selection = window.getSelection();
  const editorElement = document.querySelector<HTMLElement>('.ProseMirror');
  if (!selection || !editorElement || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  const editorRect = editorElement.getBoundingClientRect();
  if (rect.height <= 0) return null;
  return {
    top: rect.top - editorRect.top,
    bottom: rect.bottom - editorRect.top,
    height: rect.height,
  };
};

const renderPreviewCards = (previews: VividoMediaPreview[], force = true) => {
  const previewById = new Map(
    previews
      .filter((preview) => mediaIdPattern.test(preview.mediaId))
      .map((preview) => [preview.mediaId, preview]),
  );

  document.querySelectorAll<HTMLElement>('.vivido-media').forEach((element) => {
    const mediaId = element.getAttribute('data-vivido-media-id') ?? '';
    const mediaType = element.getAttribute('data-vivido-media-type') as VividoMediaType | null;
    if (!mediaType) return;
    let content = element.querySelector<HTMLElement>('.vivido-media-content');
    if (!content) {
      content = document.createElement('div');
      content.className = 'vivido-media-content';
      element.appendChild(content);
    }

    const preview = previewById.get(mediaId);
    if (!force && (!preview || preview.mediaType !== mediaType)) return;
    if (!force) {
      const needsImagePreview =
        mediaType === 'image' && isSafePreviewUri(preview?.uri) &&
        !content.querySelector('.vivido-media-image-preview');
      const needsVideoPreview =
        mediaType === 'video' && isSafePreviewUri(preview?.thumbnailUri) &&
        !content.querySelector('.vivido-media-video-preview');
      const needsFallbackPreview =
        !preview || preview.mediaType !== mediaType ||
        (mediaType === 'image' && !isSafePreviewUri(preview?.uri)) ||
        mediaType === 'audio' ||
        (mediaType === 'video' && !isSafePreviewUri(preview?.thumbnailUri));
      if (!needsImagePreview && !needsVideoPreview &&
          !(needsFallbackPreview && !content.querySelector('.vivido-media-fallback'))) return;
    }
    while (content.firstChild) content.removeChild(content.firstChild);
    if (!preview || preview.mediaType !== mediaType) {
      const fallback = document.createElement('span');
      fallback.className = 'vivido-media-label vivido-media-fallback';
      fallback.textContent = mediaType === 'image' ? '图片暂不可用' : mediaType === 'audio' ? '录音' : '视频';
      content.appendChild(fallback);
    } else if (mediaType === 'image' && isSafePreviewUri(preview.uri)) {
      const image = document.createElement('img');
      image.className = 'vivido-media-preview vivido-media-image-preview';
      image.src = preview.uri;
      image.alt = preview.label ?? '图片';
      content.appendChild(image);
      syncNaturalImageSize(image);
    } else if (mediaType === 'video' && isSafePreviewUri(preview.thumbnailUri)) {
      const image = document.createElement('img');
      image.className = 'vivido-media-preview vivido-media-video-preview';
      image.src = preview.thumbnailUri;
      image.alt = preview.label ?? '视频缩略图';
      content.appendChild(image);
      syncNaturalImageSize(image);
      const badge = document.createElement('span');
      badge.className = 'vivido-media-badge';
      badge.textContent = '视频';
      content.appendChild(badge);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'vivido-media-label vivido-media-fallback';
      fallback.textContent = mediaType === 'audio' ? '录音' : '视频';
      content.appendChild(fallback);
    }

  });
};

const observePreviewDom = () => {
  const target = document.querySelector('.ProseMirror');
  if (target === previewObserverTarget) return;
  previewObserver?.disconnect();
  previewObserverTarget = target;
  previewObserver = target
    ? new MutationObserver(() => {
        if (previewRefreshQueued) return;
        previewRefreshQueued = true;
        Promise.resolve().then(() => {
          previewRefreshQueued = false;
          renderPreviewCards(previewCache, false);
        });
      })
    : null;
  previewObserver?.observe(target!, { childList: true, subtree: true });
};

const insertMedia = (editor: Editor, mediaType: VividoMediaType, mediaId: string) => {
  if (!['image', 'audio', 'video'].includes(mediaType) || !mediaIdPattern.test(mediaId)) return false;
  const nodeName = `vivido${mediaType[0].toUpperCase()}${mediaType.slice(1)}`;
  if (!editor.schema.nodes[nodeName]) {
    console.error(`Vivido media node is not registered: ${nodeName}`);
    return false;
  }
  const inserted = editor
    .chain()
    .focus()
    .deleteSelection()
    .insertContent({ type: nodeName, attrs: { mediaId } })
    .run();
  if (!inserted) return false;

  const position = editor.state.selection.to;
  const nodeAfter = editor.state.doc.resolve(position).nodeAfter;
  if (!nodeAfter || nodeAfter.type.name !== 'paragraph') {
    editor
      .chain()
      .insertContentAt(position, { type: 'paragraph' })
      .setTextSelection(Math.min(position + 1, editor.state.doc.content.size - 1))
      .run();
  }
  return true;
};

const vividoMediaBridge = new BridgeExtension<
  {},
  VividoMediaEditorInstance,
  VividoMediaAction
>({
  forceName: VIVIDO_MEDIA_BRIDGE_NAME,
  tiptapExtension: imageNode,
  tiptapExtensionDeps: [audioNode, videoNode],
  onBridgeMessage: (editor, message) => {
    if (message.type === 'insert-media') {
      return insertMedia(editor, message.payload.mediaType, message.payload.mediaId);
    }
    if (message.type === 'set-media-previews') {
      // Preview updates are DOM-only runtime state; they do not create a
      // ProseMirror transaction and therefore cannot enter history/markup.
      previewCache = message.payload.previews;
      observePreviewDom();
      renderPreviewCards(previewCache);
      return true;
    }
    return false;
  },
  extendCSS: `
    .vivido-media { display: block; min-height: 72px; margin: 8px 0; padding: 10px; box-sizing: border-box; }
    .vivido-media-image, .vivido-media-audio, .vivido-media-video {
      border: 1px solid currentColor;
      border-radius: 8px;
      position: relative;
    }
    .vivido-media-content { display: flex; min-width: 0; min-height: 48px; align-items: center; gap: 8px; }
    .vivido-media-image .vivido-media-content, .vivido-media-video .vivido-media-content {
      flex-direction: column; align-items: stretch; gap: 6px;
    }
    .vivido-media-audio .vivido-media-content { flex-direction: row; align-items: center; }
    .vivido-media-label, .vivido-media-badge { display: inline-block; }
    .vivido-media-label { font-size: 15px; font-weight: 600; }
    .vivido-media-fallback {
      min-height: 48px; padding: 10px 12px; box-sizing: border-box;
      border-radius: 6px; background: rgba(61,44,30,.08); color: currentColor;
    }
    .vivido-media-preview { display: block; width: auto; height: auto; max-width: 100%; object-fit: contain; object-position: center; align-self: center; }
    .vivido-media-image-preview { max-width: 100%; max-height: 360px; }
    .vivido-media-video-preview { max-width: 100%; max-height: 260px; }
    .vivido-media-badge {
      position: absolute; left: 18px; bottom: 16px; padding: 3px 7px;
      border-radius: 5px; background: rgba(0,0,0,.62); color: #fff; font-size: 14px;
    }
  `,
  extendEditorState: () => ({ caretRect: readCaretRect() }),
});

// TenTap 1.0.1 derives the bridge name from tiptapExtension and ignores
// forceName when a primary extension is present. Keep the whitelist key equal
// to the native bridge while retaining the three atom nodes as the extension
// and its dependencies.
vividoMediaBridge.name = VIVIDO_MEDIA_BRIDGE_NAME;
export const VividoMediaBridge = vividoMediaBridge;
