/**
 * Markdown → sanitized HTML for the ModelHubPanel. Two callers today:
 *  - HF model-card description (passes `repo` so relative paths resolve to
 *    `huggingface.co/{repo}/resolve/main/...`)
 *  - User notes (no repo — relative URLs are left as-is, which is fine
 *    because users typing notes won't reference HF-relative paths)
 *
 * Relies on `marked` + `DOMPurify` which TagSpaces already pulls in
 * (used by `convertMarkDownToHtml` in services/utils-io.ts). No extra
 * dependency added.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

const HF_BASE = 'https://huggingface.co';

/**
 * Make a relative URL absolute against the HF repo.
 * - `./IMAGE.png` / `IMAGE.png` → `${HF_BASE}/${repo}/resolve/main/IMAGE.png`
 * - `/repo-link` → `${HF_BASE}/repo-link`
 * - already-absolute URLs (`http`, `https`, `mailto:`, `data:`) are untouched.
 */
function absolutize(url: string, repo: string): string {
  if (!url) return url;
  const trimmed = url.trim();
  if (
    /^(https?:|mailto:|data:|tel:|javascript:)/i.test(trimmed) ||
    trimmed.startsWith('#')
  ) {
    return trimmed;
  }
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('/')) return `${HF_BASE}${trimmed}`;
  // Strip leading "./"
  const clean = trimmed.replace(/^\.\//, '');
  return `${HF_BASE}/${repo}/resolve/main/${clean}`;
}

/**
 * Rewrite relative `src`/`href` attributes after sanitization. Operating
 * post-sanitize means we never touch malicious input — DOMPurify already
 * stripped `javascript:` etc. before we look at attributes.
 *
 * When `repo` is provided, relative paths are absolutized against the HF
 * repo (for HF model cards). Without it, only common safety attributes
 * (target/rel/loading) are set — relative URLs stay untouched.
 */
function rewriteRelativeUrls(html: string, repo: string | undefined): string {
  if (typeof document === 'undefined') return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = tpl.content;

  root.querySelectorAll('a[href]').forEach((el) => {
    if (repo) {
      const href = el.getAttribute('href');
      if (href) el.setAttribute('href', absolutize(href, repo));
    }
    // Open external in new tab; safer with noopener.
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  });
  root.querySelectorAll('img[src]').forEach((el) => {
    if (repo) {
      const src = el.getAttribute('src');
      if (src) el.setAttribute('src', absolutize(src, repo));
    }
    // Images can be huge — let CSS shrink them in the panel.
    el.setAttribute('loading', 'lazy');
  });

  return tpl.innerHTML;
}

export interface RenderHfMarkdownResult {
  html: string;
}

/**
 * Convert markdown to sanitized inline HTML.
 *
 * - For HF model cards: pass `repo` so relative paths resolve to
 *   `huggingface.co/{repo}/resolve/main/...`.
 * - For user notes (no repo): relative URLs are left as-is.
 */
export function renderMarkdown(
  mdContent: string,
  repo?: string,
): RenderHfMarkdownResult {
  if (!mdContent) return { html: '' };
  marked.setOptions({ pedantic: false, gfm: true, breaks: false });
  // marked.parse can return a Promise when async extensions are registered;
  // we don't use any, so it's the synchronous string overload.
  const rawHtml = marked.parse(mdContent) as string;
  const safe = DOMPurify.sanitize(rawHtml, {
    // Allow common rich-content tags but block scripts / iframes outright.
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'style'],
    // Strip inline `style` + bgcolor attributes — HF model cards routinely
    // ship with hardcoded light-mode colors (white tables, dark text) that
    // become unreadable in dark mode. Stripping forces our MUI-themed CSS
    // to take over.
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style', 'bgcolor', 'color'],
  });
  const final = rewriteRelativeUrls(safe, repo);
  return { html: final };
}

/** Backwards-compat alias for the existing call site in HfBlock. */
export const renderHfMarkdown = renderMarkdown;
