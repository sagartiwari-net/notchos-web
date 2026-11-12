/** Public site origin used for canonical URLs, sitemap, and Open Graph. */
export const SITE_ORIGIN = 'https://notch.sagartiwari.net';

export function absoluteUrl(path = '/'): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return new URL(clean, SITE_ORIGIN).href;
}
