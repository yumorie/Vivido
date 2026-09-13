import type { EditorBridge } from '@10play/tentap-editor';
import type {
  VividoMediaEditorInstance,
  VividoMediaPreview,
} from './integration/VividoMediaBridge';
import {
  canonicalizeMarkup,
  htmlToMarkup,
  markupToHtml,
  VIVIDO_HIGHLIGHT_COLOR,
} from './codec/VividoMarkupCodec';

export interface RichEditorActiveState {
  isReady: boolean;
  isBoldActive: boolean;
  isItalicActive: boolean;
  isHighlightActive: boolean;
  isFocused: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Read-only WebView caret geometry, relative to the editor document. */
  caretRect: RichEditorCaretRect | null;
}

export type RichEditorCaretRect = Readonly<{
  top: number;
  bottom: number;
  height: number;
}>;

export interface RichEditorAdapter {
  load(markup: string): void;
  getMarkup(): Promise<string>;
  focus(): void;
  blur(): void;
  toggleBold(): void;
  toggleItalic(): void;
  toggleHighlight(): void;
  undo(): void;
  redo(): void;
  insertImage(mediaId: string): void;
  insertAudio(mediaId: string): void;
  insertVideo(mediaId: string): void;
  /** Updates transient editor previews; URIs never enter persisted markup. */
  setMediaPreviews(previews: VividoMediaPreview[]): void;
  getActiveState(): Readonly<RichEditorActiveState>;
}

type EditorGetter = () => EditorBridge & VividoMediaEditorInstance;
const activeStateSetters = new WeakMap<object, (nextState: RichEditorActiveState) => void>();

export const createRichEditorAdapter = (getEditor: EditorGetter): RichEditorAdapter => {
  let mediaPreviews: VividoMediaPreview[] = [];
  const syncMediaPreviews = () => {
    getEditor().setMediaPreviews(mediaPreviews);
  };
  let state: RichEditorActiveState = {
    isReady: false,
    isBoldActive: false,
    isItalicActive: false,
    isHighlightActive: false,
    isFocused: false,
    canUndo: false,
    canRedo: false,
    caretRect: null,
  };

  const adapter: RichEditorAdapter = {
    load(markup) {
      getEditor().setContent(markupToHtml(markup));
      syncMediaPreviews();
    },
    async getMarkup() {
      const html = await getEditor().getHTML();
      return canonicalizeMarkup(htmlToMarkup(html));
    },
    focus() {
      getEditor().focus();
    },
    blur() {
      getEditor().blur();
    },
    toggleBold() {
      getEditor().toggleBold();
    },
    toggleItalic() {
      getEditor().toggleItalic();
    },
    toggleHighlight() {
      getEditor().toggleHighlight(VIVIDO_HIGHLIGHT_COLOR);
    },
    undo() {
      getEditor().undo();
      syncMediaPreviews();
    },
    redo() {
      getEditor().redo();
      syncMediaPreviews();
    },
    insertImage(mediaId) {
      getEditor().insertImage(mediaId);
    },
    insertAudio(mediaId) {
      getEditor().insertAudio(mediaId);
    },
    insertVideo(mediaId) {
      getEditor().insertVideo(mediaId);
    },
    setMediaPreviews(previews) {
      mediaPreviews = previews;
      syncMediaPreviews();
    },
    getActiveState() {
      return Object.freeze({ ...state });
    },
  };
  activeStateSetters.set(adapter, (nextState) => Object.assign(state, nextState));
  return adapter;
};

export const updateRichEditorActiveState = (
  adapter: RichEditorAdapter,
  nextState: RichEditorActiveState,
): void => {
  // The adapter object remains stable; product code only receives a frozen snapshot.
  activeStateSetters.get(adapter)?.(nextState);
};
