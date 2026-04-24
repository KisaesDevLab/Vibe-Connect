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
  // Accept both `_italic_` and `*italic*`. The underscore form needs a
  // non-underscore-or-start lookbehind so "snake_case_identifier" doesn't
  // render as italicised. The asterisk form avoids matching across the
  // `**bold**` we already replaced (the opening/closing `**` are gone by
  // now, so a lone `*x*` is unambiguously italics).
  const uItalics = bolded.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  const italics = uItalics.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const linked = italics.replace(
    /\b((?:https?|mailto):[^\s<)]+)/g,
    (m) =>
      `<a href="${m}" target="_blank" rel="noopener noreferrer" class="text-brand-700 underline">${m}</a>`,
  );
  return linked.replace(/\n/g, '<br/>');
}

/**
 * Wrap every case-insensitive match of `query` in the already-rendered markdown
 * HTML with a <mark> tag, without breaking tag boundaries. We split on tag
 * tokens, rewrite only text segments, and rejoin — so a query that happens to
 * equal `href` or `strong` doesn't corrupt a hyperlink's attributes. The query
 * is HTML-escaped before being compiled into a regex so it compares against
 * the already-escaped content produced by minimalMarkdown.
 */
export function highlightQueryInHtml(html: string, query: string): string {
  if (!query) return html;
  const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escapedQuery) return html;
  const re = new RegExp(`(${escapedQuery})`, 'gi');
  return html
    .split(/(<[^>]*>)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(re, '<mark class="bg-amber-200 text-slate-900 rounded px-0.5">$1</mark>'),
    )
    .join('');
}
