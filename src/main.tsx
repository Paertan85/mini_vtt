import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { PlayerScreen } from './components/PlayerScreen';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/cinzel/latin-600.css';
import './index.css';

const isViewOnly = new URLSearchParams(window.location.search).get('mode') === 'view';
if (isViewOnly) {
  document.title = 'Mini VTT — Player Screen';
}

// Files dropped outside the library drop zones would otherwise make Chromium
// open them in place of the app. Drop zones call preventDefault themselves, so
// only unhandled drags are swallowed here (and shown as "no drop").
window.addEventListener('dragover', (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (event) => {
  if (!event.defaultPrevented) event.preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isViewOnly ? <PlayerScreen /> : <App />}</React.StrictMode>,
);
