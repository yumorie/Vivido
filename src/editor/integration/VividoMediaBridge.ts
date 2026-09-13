import { BridgeExtension } from '@10play/tentap-editor';
import { VIVIDO_MEDIA_BRIDGE_NAME } from './VividoMediaContract';

export type VividoMediaType = 'image' | 'audio' | 'video';

/** Runtime-only media data used to render an editor preview. Never serialized. */
export type VividoMediaPreview = {
  mediaId: string;
  mediaType: VividoMediaType;
  uri?: string;
  thumbnailUri?: string;
  label?: string | null;
};

export type VividoMediaAction =
  | {
      type: 'insert-media';
      payload: { mediaType: VividoMediaType; mediaId: string };
    }
  | {
      type: 'set-media-previews';
      payload: { previews: VividoMediaPreview[] };
    };

export type VividoMediaEditorInstance = {
  insertImage: (mediaId: string) => void;
  insertAudio: (mediaId: string) => void;
  insertVideo: (mediaId: string) => void;
  setMediaPreviews: (previews: VividoMediaPreview[]) => void;
};

export const VividoMediaBridge = new BridgeExtension<
  {},
  VividoMediaEditorInstance,
  VividoMediaAction
>({
  forceName: VIVIDO_MEDIA_BRIDGE_NAME,
  extendEditorInstance: (sendBridgeMessage) => ({
    insertImage: (mediaId) =>
      sendBridgeMessage({ type: 'insert-media', payload: { mediaType: 'image', mediaId } }),
    insertAudio: (mediaId) =>
      sendBridgeMessage({ type: 'insert-media', payload: { mediaType: 'audio', mediaId } }),
    insertVideo: (mediaId) =>
      sendBridgeMessage({ type: 'insert-media', payload: { mediaType: 'video', mediaId } }),
    setMediaPreviews: (previews) =>
      sendBridgeMessage({ type: 'set-media-previews', payload: { previews } }),
  }),
  extendCSS: `
    .vivido-media { display: block; min-height: 48px; margin: 8px 0; }
    .vivido-media-image, .vivido-media-audio, .vivido-media-video {
      border: 1px dashed currentColor;
      border-radius: 8px;
    }
  `,
});
