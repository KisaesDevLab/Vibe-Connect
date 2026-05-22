import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { registerServiceWorker } from './lib/pwa.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Anonymous intake is read-mostly; a slightly aggressive client cache
      // saves a round-trip when the user navigates back to the landing
      // from the form. The server's own 60s in-memory cache backs this.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
// PWA: register after render so the SW install doesn't race with
// initial bundle parse. iOS Safari requires manifest + SW + at least
// one prior visit before "Add to Home Screen" treats the intake as
// an installable PWA rather than a generic Safari bookmark.
registerServiceWorker();
