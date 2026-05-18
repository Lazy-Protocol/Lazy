import { useEffect } from 'react';

type PageMeta = {
  title: string;
  description: string;
  canonical?: string;
};

const ORIGIN = 'https://getlazy.xyz';

function setMeta(selector: string, attr: string, value: string) {
  const el = document.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

// Returns the existing element matching selector, or creates one of `tag`
// with the given attributes and appends it to <head>.
function ensureHeadEl(
  selector: string,
  tag: 'meta' | 'link',
  attrs: Record<string, string>,
): Element {
  let el = document.querySelector(selector);
  if (!el) {
    el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.head.appendChild(el);
  }
  return el;
}

/**
 * Sets document.title and head metadata on mount, restores on unmount.
 * Updates Open Graph and Twitter Card tags so each route has its own
 * shareable metadata. The canonical link and og:url are created on the
 * fly if absent (they are intentionally not in index.html so the SPA
 * does not advertise a wrong static value).
 */
export function usePageMeta({ title, description, canonical }: PageMeta) {
  useEffect(() => {
    const prevTitle = document.title;

    const descEl = document.querySelector('meta[name="description"]');
    const ogTitleEl = document.querySelector('meta[property="og:title"]');
    const ogDescEl = document.querySelector('meta[property="og:description"]');
    const twTitleEl = document.querySelector('meta[name="twitter:title"]');
    const twDescEl = document.querySelector('meta[name="twitter:description"]');

    const canonicalEl = ensureHeadEl(
      'link[rel="canonical"]',
      'link',
      { rel: 'canonical' },
    ) as HTMLLinkElement;
    const ogUrlEl = ensureHeadEl(
      'meta[property="og:url"]',
      'meta',
      { property: 'og:url' },
    );

    const prev = {
      desc: descEl?.getAttribute('content') ?? '',
      ogTitle: ogTitleEl?.getAttribute('content') ?? '',
      ogDesc: ogDescEl?.getAttribute('content') ?? '',
      ogUrl: ogUrlEl.getAttribute('content') ?? '',
      twTitle: twTitleEl?.getAttribute('content') ?? '',
      twDesc: twDescEl?.getAttribute('content') ?? '',
      canonical: canonicalEl.getAttribute('href') ?? '',
    };

    document.title = title;
    setMeta('meta[name="description"]', 'content', description);
    setMeta('meta[property="og:title"]', 'content', title);
    setMeta('meta[property="og:description"]', 'content', description);
    setMeta('meta[name="twitter:title"]', 'content', title);
    setMeta('meta[name="twitter:description"]', 'content', description);

    const canonicalHref = canonical
      ? `${ORIGIN}${canonical}`
      : `${ORIGIN}${window.location.pathname}`;
    ogUrlEl.setAttribute('content', canonicalHref);
    canonicalEl.setAttribute('href', canonicalHref);

    return () => {
      document.title = prevTitle;
      setMeta('meta[name="description"]', 'content', prev.desc);
      setMeta('meta[property="og:title"]', 'content', prev.ogTitle);
      setMeta('meta[property="og:description"]', 'content', prev.ogDesc);
      setMeta('meta[name="twitter:title"]', 'content', prev.twTitle);
      setMeta('meta[name="twitter:description"]', 'content', prev.twDesc);
      ogUrlEl.setAttribute('content', prev.ogUrl);
      if (prev.canonical) canonicalEl.setAttribute('href', prev.canonical);
    };
  }, [title, description, canonical]);
}
