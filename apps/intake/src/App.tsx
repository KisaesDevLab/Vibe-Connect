import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { getBoot } from './lib/boot.js';
import { IntakeForm } from './pages/IntakeForm.js';
import { Landing } from './pages/Landing.js';
import { TokenizedIntake } from './pages/TokenizedIntake.js';
import { Done, Upload } from './pages/Upload.js';

/**
 * Phase 28.3 — anonymous intake SPA root.
 *
 * Three public routes ship in this bundle (28.3 lands /intake; 28.4 adds
 * /intake/:staffId; 28.14 adds /intake/t/:token):
 *
 *   /intake             → staff card grid (28.3, this sub-phase)
 *   /intake/:staffId    → intake form for selected staff (28.4)
 *   /intake/t/:token    → tokenized intake landing (28.14)
 *
 * The basename comes from window.__VIBE_BOOT__.basePath so the same bundle
 * works under both single-app ('/') and multi-app ('/connect/') prefixes
 * without rebuild. Anything outside /intake redirects to /intake (this
 * SPA has no other surface — landing in / would just confuse visitors).
 */
export function App(): JSX.Element {
  const base = getBoot().basePath || '/';
  return (
    <BrowserRouter basename={base}>
      <Routes>
        <Route path="/intake" element={<Landing />} />
        {/* 28.14 tokenized link landing — must come BEFORE /:staffId so
            the literal `t` segment matches here, not as a staff UUID. */}
        <Route path="/intake/t/:token" element={<TokenizedIntake />} />
        <Route path="/intake/:staffId" element={<IntakeForm />} />
        <Route path="/intake/:staffId/upload" element={<Upload />} />
        <Route path="/intake/:staffId/done" element={<Done />} />
        <Route path="*" element={<Navigate to="/intake" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
