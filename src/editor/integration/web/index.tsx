import React from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent } from '@tiptap/react';
import {
  BoldBridge,
  CoreBridge,
  HardBreakBridge,
  HighlightBridge,
  HistoryBridge,
  ItalicBridge,
  useTenTap,
} from '@10play/tentap-editor/web';
import { VividoMediaBridge } from './VividoMediaBridge';

declare global {
  interface Window {
    contentInjected?: boolean;
    whiteListBridgeExtensions: string[];
    dynamicHeight?: boolean;
  }
}

const bridges = [
  CoreBridge,
  BoldBridge,
  ItalicBridge,
  HighlightBridge,
  HistoryBridge,
  HardBreakBridge,
  VividoMediaBridge,
].filter(
  (bridge) =>
    !window.whiteListBridgeExtensions || window.whiteListBridgeExtensions.includes(bridge.name),
);

const Tiptap = () => {
  const editor = useTenTap({ bridges });
  return <EditorContent editor={editor} className={window.dynamicHeight ? 'dynamic-height' : undefined} />;
};

const mountWhenInjected = () => {
  if (!window.contentInjected) return false;
  const container = document.getElementById('root');
  if (!container) return false;
  createRoot(container).render(<Tiptap />);
  return true;
};

const interval = window.setInterval(() => {
  if (mountWhenInjected()) window.clearInterval(interval);
}, 1);
