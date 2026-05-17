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

/**
 * Sets document.title and meta description on mount, restores on unmount.
 * Updates Open Graph and Twitter Card tags too so each route has its own
 * shareable metadata. The static <meta> tags in index.html act as the
 * default that is overwritten when this hook runs.
 */
export function usePageMeta({ title, description, canonical }: PageMeta) {
  useEffect(() => {
    const prevTitle = document.title;
    const descEl = document.querySelector('meta[name="description"]');
    const ogTitleEl = document.querySelector('meta[property="og:title"]');
    const ogDescEl = document.querySelector('meta[property="og:description"]');
    const ogUrlEl = document.querySelector('meta[property="og:url"]');
    const twTitleEl = document.querySelector('meta[name="twitter:title"]');
    const twDescEl = document.querySelector('meta[name="twitter:description"]');
    const canonicalEl = document.querySelector('link[rel="canonical"]');

    const prev = {
      desc: descEl?.getAttribute('content') ?? '',
      ogTitle: ogTitleEl?.getAttribute('content') ?? '',
      ogDesc: ogDescEl?.getAttribute('content') ?? '',
      ogUrl: ogUrlEl?.getAttribute('content') ?? '',
      twTitle: twTitleEl?.getAttribute('content') ?? '',
      twDesc: twDescEl?.getAttribute('content') ?? '',
      canonical: canonicalEl?.getAttribute('href') ?? '',
    };

    document.title = title;
    setMeta('meta[name="description"]', 'content', description);
    setMeta('meta[property="og:title"]', 'content', title);
    setMeta('meta[property="og:description"]', 'content', description);
    setMeta('meta[name="twitter:title"]', 'content', title);
    setMeta('meta[name="twitter:description"]', 'content', description);

    const canonicalHref = canonical ? `${ORIGIN}${canonical}` : `${ORIGIN}${window.location.pathname}`;
    setMeta('meta[property="og:url"]', 'content', canonicalHref);
    if (canonicalEl) canonicalEl.setAttribute('href', canonicalHref);

    return () => {
      document.title = prevTitle;
      setMeta('meta[name="description"]', 'content', prev.desc);
      setMeta('meta[property="og:title"]', 'content', prev.ogTitle);
      setMeta('meta[property="og:description"]', 'content', prev.ogDesc);
      setMeta('meta[property="og:url"]', 'content', prev.ogUrl);
      setMeta('meta[name="twitter:title"]', 'content', prev.twTitle);
      setMeta('meta[name="twitter:description"]', 'content', prev.twDesc);
      if (canonicalEl && prev.canonical) canonicalEl.setAttribute('href', prev.canonical);
    };
  }, [title, description, canonical]);
}
