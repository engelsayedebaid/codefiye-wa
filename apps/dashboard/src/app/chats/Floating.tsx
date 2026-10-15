import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../ui';
import { usePrivacyMode } from './privacy';

/**
 * A layer for fixed menus and popovers opened from inside the chats page, rendered at the end of
 * <body>: an ancestor with a transform, filter or backdrop blur (rows, animated panes, focus mode) would
 * otherwise become the box `position: fixed` is measured from, and clip or misplace them. It keeps
 * private mode, whose blur is scoped to the page root.
 */
export function Floating({ children }: { children: ReactNode }) {
  const privacy = usePrivacyMode();
  return createPortal(<div className={cx(privacy && 'privacy-on')}>{children}</div>, document.body);
}
