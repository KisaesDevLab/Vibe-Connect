import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { registerServiceWorker } from './lib/pwa.js';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
// PWA: register after React mounts so the SW install promise doesn't
// race with the initial bundle parse. iOS Safari additionally requires
// a manifest + SW + at least one prior visit before "Add to Home
// Screen" appears as an installable PWA (vs. a generic Safari bookmark).
registerServiceWorker();
