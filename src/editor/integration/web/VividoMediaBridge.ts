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
      return [
        'div',
        mergeAttributes(HTMLAttributes, {
          'data-vivido-media-type': mediaType,
          class: `vivido-media vivido-media-${mediaType}`,
        }),
      ];
    },
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('div');
        dom.className = `vivido-media vivido-media-${mediaType}`;
        dom.setAttribute('data-vivido-media-type', mediaType);
        if (mediaType === 'image' && typeof node.attrs.alt === 'string') {
          dom.setAttribute('data-vivido-media-alt', node.attrs.alt);
        }
        if (typeof node.attrs.mediaId === 'string' && mediaIdPattern.test(node.attrs.mediaId)) {
          dom.setAttribute('data-vivido-media-id', node.attrs.mediaId);
        }
        return {
          dom,
          // Runtime preview children are not document content. Ignore their
          // DOM mutations so ProseMirror never creates a transaction from them.
          ignoreMutation: () => true,
          update: (updatedNode) => {
            if (updatedNode.type.name !== node.type.name) return false;
            const nextId = updatedNode.attrs.mediaId;
            if (typeof nextId === 'string' && mediaIdPattern.test(nextId)) {
              dom.setAttribute('data-vivido-media-id', nextId);
            }
            return true;
          },
          destroy: () => {
            disconnectPreviewObservers(dom);
          },
        };
      };
    },
  });

const imageNode = createMediaNode('image');
const audioNode = createMediaNode('audio');
const videoNode = createMediaNode('video');

const previewUriPattern = /^(?:file|content):\/\//i;
let previewCache: VividoMediaPreview[] = [];
const previewResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();

const isSafePreviewUri = (uri: string | undefined): uri is string =>
  Boolean(uri && previewUriPattern.test(uri) && !/^data:/i.test(uri));

const fitPreviewImage = (image: HTMLImageElement, maxHeight: number) => {
  const container = image.parentElement;
  if (!container || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
  const availableWidth = container.clientWidth;
  if (availableWidth <= 0) return;
  const ratio = image.naturalWidth / image.naturalHeight;
  let renderedWidth = Math.min(image.naturalWidth, availableWidth);
  let renderedHeight = renderedWidth / ratio;
  if (renderedHeight > maxHeight) {
    renderedHeight = maxHeight;
    renderedWidth = renderedHeight * ratio;
  }
  image.style.width = `${Math.max(1, Math.round(renderedWidth))}px`;
  image.style.height = `${Math.max(1, Math.round(renderedHeight))}px`;
  image.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
};

const syncNaturalImageSize = (image: HTMLImageElement, maxHeight: number) => {
  const apply = () => fitPreviewImage(image, maxHeight);
  image.addEventListener('load', apply, { once: true });
  apply();
  if (typeof ResizeObserver !== 'undefined' && image.parentElement) {
    const observer = new ResizeObserver(apply);
    observer.observe(image.parentElement);
    previewResizeObservers.set(image, observer);
  }
};

const disconnectPreviewObservers = (content: HTMLElement) => {
  content.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    previewResizeObservers.get(image)?.disconnect();
    previewResizeObservers.delete(image);
  });
};

/** Read-only caret geometry for the native outer-scroll visibility helper. */
const readCaretRect = (editor: Editor) => {
  const editorElement = document.querySelector<HTMLElement>('.ProseMirror');
  const pmSelection = editor.state.selection;
  if (!editorElement || !pmSelection.empty || !('$cursor' in pmSelection)) {
    return null;
  }
  const editorRect = editorElement.getBoundingClientRect();

  // ProseMirror's own coordinate API handles an empty paragraph/collapsed
  // caret even when the browser Range has zero height. It is read-only: no
  // selection or transaction is created here.
  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.head, 1);
    if (Number.isFinite(coords.top) && Number.isFinite(coords.bottom)) {
      return {
        top: coords.top - editorRect.top,
        bottom: coords.bottom - editorRect.top,
        height: Math.max(1, coords.bottom - coords.top),
      };
    }
  } catch {
    // The DOM Range fallback below is useful during WebView teardown.
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  if (rect.height > 0) {
    return {
      top: rect.top - editorRect.top,
      bottom: rect.bottom - editorRect.top,
      height: rect.height,
    };
  }

  // Android WebView may report a zero-height Range in an empty paragraph.
  // Use that paragraph's actual box only as a geometry fallback.
  const anchor = selection.anchorNode instanceof Element
    ? selection.anchorNode
    : selection.anchorNode?.parentElement;
  const block = anchor?.closest('.ProseMirror p');
  const blockRect = block?.getBoundingClientRect();
  if (blockRect && blockRect.height > 0) {
    return {
      top: blockRect.top - editorRect.top,
      bottom: blockRect.bottom - editorRect.top,
      height: blockRect.height,
    };
  }
  return null;
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
    disconnectPreviewObservers(content);
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
      syncNaturalImageSize(image, 360);
    } else if (mediaType === 'video' && isSafePreviewUri(preview.thumbnailUri)) {
      const image = document.createElement('img');
      image.className = 'vivido-media-preview vivido-media-video-preview';
      image.src = preview.thumbnailUri;
      image.alt = preview.label ?? '视频缩略图';
      content.appendChild(image);
      syncNaturalImageSize(image, 260);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'vivido-media-label vivido-media-fallback';
      fallback.textContent = mediaType === 'audio' ? '录音' : '视频';
      content.appendChild(fallback);
    }

  });
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
      renderPreviewCards(previewCache);
      return true;
    }
    return false;
  },
  extendCSS: `
    .vivido-media { display: block; margin: 10px 0; box-sizing: border-box; }
    .vivido-media-image, .vivido-media-audio, .vivido-media-video {
      position: relative;
      border-radius: 8px;
    }
    .vivido-media-content { display: flex; min-width: 0; min-height: 48px; align-items: center; gap: 8px; }
    .vivido-media-image .vivido-media-content, .vivido-media-video .vivido-media-content {
      flex-direction: column; align-items: stretch; gap: 6px;
    }
    .vivido-media-audio .vivido-media-content { flex-direction: row; align-items: center; }
    .vivido-media-label { display: inline-block; }
    .vivido-media-label { font-size: 15px; font-weight: 600; }
    .vivido-media-fallback {
      min-height: 48px; padding: 10px 12px; box-sizing: border-box;
      border-radius: 6px; background: rgba(61,44,30,.08); color: currentColor;
    }
    .vivido-media-preview { display: block; width: auto; height: auto; max-width: 100%; object-fit: contain; object-position: center; align-self: center; }
    .vivido-media-image-preview { max-width: 100%; max-height: 360px; }
    .vivido-media-video-preview { max-width: 100%; max-height: 260px; }
    .vivido-media-video .vivido-media-content::after {
      content: '▶'; position: absolute; left: 50%; top: 50%;
      transform: translate(-50%, -50%); width: 42px; height: 42px;
      border-radius: 21px; display: grid; place-items: center;
      padding-left: 2px; box-sizing: border-box;
      background: rgba(61,44,30,.72); color: #f5f0e6; font-size: 18px;
    }
    .ProseMirror-selectednode {
      outline: 2px solid #c47030; outline-offset: 2px;
      box-shadow: 0 0 0 3px rgba(196,112,48,.18); border-radius: 8px;
    }
  `,
  extendEditorState: (editor) => ({ caretRect: readCaretRect(editor) }),
});

// TenTap 1.0.1 derives the bridge name from tiptapExtension and ignores
// forceName when a primary extension is present. Keep the whitelist key equal
// to the native bridge while retaining the three atom nodes as the extension
// and its dependencies.
vividoMediaBridge.name = VIVIDO_MEDIA_BRIDGE_NAME;
export const VividoMediaBridge = vividoMediaBridge;
