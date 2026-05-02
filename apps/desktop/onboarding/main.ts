// First-run onboarding wiring. Walks the user from "what's your URL?" to a
// validated, persisted, navigated-to appliance. Keeps DOM concerns thin —
// the actual logic lives in lib/url.ts (pure) and lib/tauri.ts (IPC).
//
// Flow:
//   1. On load, ask Tauri whether a URL is already stored. If yes,
//      we shouldn't even be on this page — navigate immediately.
//   2. The form's submit handler:
//      a. normalizeApplianceUrl()  → static validation
//      b. fetch ${url}/__vibe-boot.js → confirms it's a Vibe server
//      c. validateBootScript()     → parses + validates the response shape
//      d. setApplianceUrl()        → stores via tauri-plugin-store
//      e. navigateToAppliance()    → Rust navigates the webview
//   3. Each error path renders a precise message (lib/url.ts owns the copy)
//      so the user understands what failed.
import {
  describeNormalizeError,
  describeProbeError,
  normalizeApplianceUrl,
  validateBootScript,
  type NormalizeOk,
  type ProbeResult,
} from './lib/url.js';
import {
  getApplianceUrl,
  getDesktopVersion,
  navigateToAppliance,
  setApplianceUrl,
} from './lib/tauri.js';

const PROBE_TIMEOUT_MS = 10_000;

type StatusKind = 'info' | 'error' | 'success';

const $form = document.getElementById('form') as HTMLFormElement | null;
const $url = document.getElementById('url') as HTMLInputElement | null;
const $allowHttp = document.getElementById('allowHttp') as HTMLInputElement | null;
const $submit = document.getElementById('submit') as HTMLButtonElement | null;
const $status = document.getElementById('status') as HTMLParagraphElement | null;
const $version = document.getElementById('buildVersion') as HTMLSpanElement | null;

if (!$form || !$url || !$allowHttp || !$submit || !$status || !$version) {
  // The HTML and TS are co-versioned; if this ever fires the bundle is broken.
  // Throwing surfaces it loudly at boot rather than as a silent dead form.
  throw new Error('onboarding: missing required DOM nodes');
}

void boot();

async function boot(): Promise<void> {
  // If we already have a stored URL, skip the form entirely. This branch
  // covers the case where the Rust shell mistakenly loaded the onboarding
  // page despite a stored URL (e.g., a developer-triggered hard reload).
  try {
    const existing = await getApplianceUrl();
    if (existing) {
      setStatus('info', 'Loading your firm’s server…');
      await navigateToAppliance();
      return;
    }
  } catch (err) {
    // Non-fatal — we just continue to show the form.
    console.warn('[onboarding] getApplianceUrl failed:', err);
  }

  // Surface the desktop's own version in the footer.
  try {
    $version!.textContent = await getDesktopVersion();
  } catch {
    /* leave default */
  }

  $form!.addEventListener('submit', (event) => {
    event.preventDefault();
    void handleSubmit();
  });
}

async function handleSubmit(): Promise<void> {
  setStatus('info', '');
  setBusy(true);
  try {
    const allowHttp = $allowHttp!.checked;
    const norm = normalizeApplianceUrl($url!.value, { allowHttp });
    if (!norm.ok) {
      setStatus('error', describeNormalizeError(norm.error, norm.detail));
      return;
    }

    setStatus('info', `Checking ${norm.hostname}…`);

    const probe = await probeServer(norm);
    if (!probe.ok) {
      setStatus('error', describeProbeError(probe.error));
      return;
    }

    const label = probe.appName ?? norm.hostname;
    setStatus('success', `Connected to ${label} (build ${probe.buildVersion}). Loading…`);

    await setApplianceUrl(norm.url);
    await navigateToAppliance();
  } catch (err) {
    setStatus('error', humanizeFetchError(err));
    setBusy(false);
  }
}

/**
 * Issue a fetch against `${url}/__vibe-boot.js` with a hard timeout, then
 * funnel the body through validateBootScript(). Network-level failures are
 * thrown so the caller's try/catch handles them; protocol-level failures
 * (200 but wrong body, 404, 5xx) are returned as ProbeFail.
 *
 * No-cache headers prevent a webview proxy from feeding us a stale response.
 */
async function probeServer(norm: NormalizeOk): Promise<ProbeResult> {
  const url = `${norm.url}/__vibe-boot.js`;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      cache: 'no-store',
      credentials: 'omit',
      // Explicit Accept so a misconfigured upstream that returns text/html
      // for unknown paths doesn't accidentally pass the marker check below.
      headers: { Accept: 'application/javascript, */*;q=0.1' },
    });
    if (!res.ok) {
      return { ok: false, error: 'not_a_vibe_server', detail: `http ${res.status}` };
    }
    const body = await res.text();
    return validateBootScript(body);
  } finally {
    window.clearTimeout(timer);
  }
}

function setStatus(kind: StatusKind, message: string): void {
  $status!.textContent = message;
  $status!.classList.remove('error', 'success');
  if (kind === 'error') $status!.classList.add('error');
  if (kind === 'success') $status!.classList.add('success');
}

function setBusy(busy: boolean): void {
  $submit!.disabled = busy;
  $url!.disabled = busy;
  $submit!.textContent = busy ? 'Checking…' : 'Continue';
}

/**
 * Translates raw fetch / DOM errors into something the user can act on.
 * The DOMException name 'AbortError' is the timeout we set above; treat it
 * separately so the message is "took too long" rather than "aborted".
 */
function humanizeFetchError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'The server took too long to respond. Check the URL and your network connection.';
  }
  if (err instanceof TypeError) {
    // Browser-thrown "Failed to fetch" — DNS miss, refused connection,
    // certificate failure, mixed content, etc.
    return 'Couldn’t reach that server. Check the URL, your network, and that the server uses a valid certificate.';
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
