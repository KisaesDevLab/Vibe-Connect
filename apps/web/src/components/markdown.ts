/**
 * Minimal markdown: **bold**, _italic_, autolink. Deliberately limited — see the plan's
 * non-goals list.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function minimalMarkdown(raw: string): string {
  const escaped = escapeHtml(raw);
  const bolded = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const italics = bolded.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  const linked = italics.replace(
    /\b((?:https?|mailto):[^\s<)]+)/g,
    (m) =>
      `<a href="${m}" target="_blank" rel="noopener noreferrer" class="text-brand-700 underline">${m}</a>`,
  );
  return linked.replace(/\n/g, '<br/>');
}
