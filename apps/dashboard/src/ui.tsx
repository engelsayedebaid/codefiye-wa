import type { ReactNode } from 'react';

const paths = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M10 18h4',
  chat: 'M21 11a8 8 0 0 1-8 8H7l-5 3V11a9 9 0 0 1 18-4 M7 10h9 M7 14h6',
  key: 'M14 3a6 6 0 1 1-4 10L3 20H1v-4l7-7a6 6 0 0 1 6-6z M16 7h.01',
  code: 'm8 5-7 7 7 7 M16 5l7 7-7 7 M14 3l-4 18',
  arrow: 'M20 12H4 m6-6-6 6 6 6',
  check: 'm5 12 4 4L19 6',
  plus: 'M12 5v14 M5 12h14',
  chart: 'M4 3v18h18 M8 15v-4 M13 15V6 M18 15V9',
  shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z m-4 10 3 3 5-6',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-4',
  server: 'M3 3h18v7H3z M3 14h18v7H3z M7 6h.01 M7 17h.01 M11 6h6 M11 17h6',
  card: 'M2 5h20v14H2z M2 10h20 M6 15h4',
  hook: 'M7 3v11a5 5 0 0 0 10 0V8 m-3 3 3-3 3 3 M4 3h6',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  logout: 'M9 3H3v18h6 M9 12h13 m-5-5 5 5-5 5',
  refresh: 'M20 7a9 9 0 0 0-16 1 M20 2v5h-5 M4 17a9 9 0 0 0 16-1 M4 22v-5h5',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'm6 6 12 12 M6 18 18 6',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 m5 12 6 6',
  copy: 'M9 9h12v12H9z M5 15H3V3h12v2',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v3 M12 20v3 M4.2 4.2l2.1 2.1 M17.7 17.7l2.1 2.1 M1 12h3 M20 12h3 M4.2 19.8l2.1-2.1 M17.7 6.3l2.1-2.1',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function Brand() {
  return <a className="brand" href="/" aria-label="wa-platform الرئيسية"><span className="brand-symbol"><Icon name="chat" size={23} /></span><span dir="ltr">wa<span className="brand-dot">.</span>platform<small>تواصل أبسط. أعمال أقرب.</small></span></a>;
}
export function Empty({ title, children, icon = 'chat' }: { title: string; children?: ReactNode; icon?: IconName }) {
  return <div className="empty"><span className="icon-tile"><Icon name={icon} size={26} /></span><h3>{title}</h3><div>{children}</div></div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row-between" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 600 }}>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="إغلاق"><Icon name="close" size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
export const number = (value: number) => value.toLocaleString('ar-EG');
export const date = (value: string | null) => value ? new Date(value).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
