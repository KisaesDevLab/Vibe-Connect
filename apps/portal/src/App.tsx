import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { IdentifyPage } from './pages/Identify.js';
import { VerifyPage } from './pages/Verify.js';
import { StepUpPage } from './pages/StepUp.js';
import { ConversationsPage } from './pages/Conversations.js';

const qc = new QueryClient();

export function App(): JSX.Element {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<IdentifyPage />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/stepup" element={<StepUpPage />} />
          <Route path="/messages" element={<ConversationsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
