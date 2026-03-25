import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { registerSW } from 'virtual:pwa-register';

// Register service worker with more robust handling
const updateSW = registerSW({
  onNeedRefresh() {
    if (confirm('新內容已發佈，是否重新整理以更新？')) {
      updateSW(true);
    }
  },
  onOfflineReady() {
    console.log('應用程式已準備好離線使用');
  },
  immediate: true,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
