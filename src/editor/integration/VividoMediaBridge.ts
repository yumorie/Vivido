import { BridgeExtension } from '@10play/tentap-editor';

export type VividoMediaType = 'image' | 'audio' | 'video';

export type VividoMediaAction = {
  type: 'insert-media';
  payload: { mediaType: VividoMediaType; mediaId: string };
};

export type VividoMediaEditorInstance = {
  insertImage: (mediaId: string) => void;
  insertAudio: (mediaId: string) => void;
  insertVideo: (mediaId: string) => void;
};

export const VividoMediaBridge = new BridgeExtension<
  {},
  VividoMediaEditorInstance,
  VividoMediaAction
>({
  forceName: 'vividoMedia',
  extendEditorInstance: (sendBridgeMessage) => ({
    insertImage: (mediaId) =>
      sendBridgeMessage({ type: 'insert-media', payload: { mediaType: 'image', mediaId } }),
    insertAudio: (mediaId) =>
      sendBridgeMessage({ type: 'insert-media', payload: { mediaType: 'audio', mediaId } }),
    insertVideo: (mediaId) =>
      sendBridgeMessage({ type: 'insert-media', payload: { mediaType: 'video', mediaId } }),
  }),
  extendCSS: `
    .vivido-media { display: block; min-height: 48px; margin: 8px 0; }
    .vivido-media-image, .vivido-media-audio, .vivido-media-video {
      border: 1px dashed currentColor;
      border-radius: 8px;
    }
  `,
});
