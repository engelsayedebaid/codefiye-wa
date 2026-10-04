import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useState } from 'react';

const listeners = new Set<() => void>();

/** Client-side navigation via the History API (the API and Vite both serve index.html for unknown paths). */
export function navigate(to: string, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  listeners.forEach((l) => l());
  const hash = to.split('#')[1];
  if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' }), 50);
  else window.scrollTo({ top: 0 });
}

export function usePath() {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

// Not /api-keys: the dev proxy and the API's SPA fallback treat every /api… path as an API call.
const APP_PATHS = ['/dashboard', '/sessions', '/templates', '/keys', '/subscription', '/admin', '/ads', '/chats'];
export const isAppPath = (path: string) => APP_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

/** Where to go after logging in: the `next` query param when it's one of our app pages. */
export function afterLoginPath() {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') && isAppPath(next.split('?')[0]!) ? next : '/dashboard';
}

export function useQuery() {
  const [search, setSearch] = useState(() => location.search);
  useEffect(() => {
    const update = () => setSearch(location.search);
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return new URLSearchParams(search);
}

/** `<a>` that navigates in-app for internal paths; external links, hashes and modified clicks behave normally. */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const internal = href.startsWith('/') && !href.startsWith('/docs') && !href.startsWith('/api');
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || !internal || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || rest.target) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
