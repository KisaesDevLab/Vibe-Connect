import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { IdentifyPage } from './pages/Identify.js';
import { InvitePage } from './pages/Invite.js';
import { VerifyPage } from './pages/Verify.js';
import { StepUpPage } from './pages/StepUp.js';
import { ConversationsPage } from './pages/Conversations.js';
import { FilesPage } from './pages/Files.js';
import { getBoot } from './lib/boot.js';

const qc = new QueryClient();

export function App(): JSX.Element {
  // Distribution mode: BrowserRouter strips the basename from the URL before
  // matching routes, so the same <Route path="/messages" /> works whether the
  // app is mounted at '/' or '/connect'. Empty string falls back to '/' which
  // is what react-router expects in single-app mode.
  const basename = getBoot().basePath || '/';
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter basename={basename}>
        <Routes>
          <Route path="/" element={<IdentifyPage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/stepup" element={<StepUpPage />} />
          <Route path="/messages" element={<ConversationsPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
