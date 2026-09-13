import { Node, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { BridgeExtension } from '@10play/tentap-editor/web';
import type {
  VividoMediaAction,
  VividoMediaEditorInstance,
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
          'data-vivido-media-label': mediaType === 'image' ? '图片' : mediaType === 'audio' ? '录音' : '视频',
          class: `vivido-media vivido-media-${mediaType}`,
        }),
      ];
    },
  });

const imageNode = createMediaNode('image');
const audioNode = createMediaNode('audio');
const videoNode = createMediaNode('video');

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
  onBridgeMessage: (editor, message) =>
    message.type === 'insert-media'
      ? insertMedia(editor, message.payload.mediaType, message.payload.mediaId)
      : false,
  extendCSS: `
    .vivido-media { display: block; min-height: 48px; margin: 8px 0; padding: 12px; }
    .vivido-media-image, .vivido-media-audio, .vivido-media-video {
      border: 1px dashed currentColor;
      border-radius: 8px;
      position: relative;
    }
    .vivido-media::before {
      content: attr(data-vivido-media-label) ' · ' attr(data-vivido-media-id);
      display: block;
      font-size: 14px;
      opacity: .75;
    }
  `,
});

// TenTap 1.0.1 derives the bridge name from tiptapExtension and ignores
// forceName when a primary extension is present. Keep the whitelist key equal
// to the native bridge while retaining the three atom nodes as the extension
// and its dependencies.
vividoMediaBridge.name = VIVIDO_MEDIA_BRIDGE_NAME;
export const VividoMediaBridge = vividoMediaBridge;
