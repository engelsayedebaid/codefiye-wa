import { CheckCheck, FileText, MapPin, Mic, Play, Send, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cx, delay } from '../ui';

function Bubble({ out, time, children, className, at }: { out?: boolean; time: string; children: ReactNode; className?: string; at: number }) {
  return (
    <div className={cx('chat-bubble flex', out ? 'justify-end' : 'justify-start')} style={delay(at)}>
      <div
        className={cx(
          'max-w-[78%] rounded-xl px-3 py-2 text-[13px] leading-snug text-[#111b21] shadow-sm',
          out ? 'rounded-ss-sm bg-[#d9fdd3]' : 'rounded-se-sm bg-white',
          className,
        )}
      >
        {children}
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-[#667781]">
          <span className="ltr">{time}</span>
          {out && <CheckCheck className="size-3.5 text-[#53bdeb]" />}
        </div>
      </div>
    </div>
  );
}

/** Decorative phone with a WhatsApp-like chat, built in HTML/CSS (no screenshots). */
export function PhoneMock({ className, variant = 'full' }: { className?: string; variant?: 'full' | 'mini' }) {
  const { t } = useI18n();
  const p = t.landing.phone;
  return (
    <div aria-hidden className={cx('relative mx-auto w-[305px] sm:w-[350px]', className)}>
      {/* Ambient glow behind the phone */}
      <div className="pointer-events-none absolute -inset-4 -z-10 rounded-[3.2rem] bg-gradient-to-tr from-brand/25 via-teal/15 to-transparent blur-2xl" />

      <div className="rounded-[2.85rem] border border-white/20 bg-gradient-to-b from-[#222625] via-[#111312] to-[#080909] p-2.5 shadow-[0_35px_90px_-20px_rgba(0,0,0,0.85),inset_0_1px_1px_rgba(255,255,255,0.2)]">
        <div className="relative overflow-hidden rounded-[2.3rem] border border-black/40 bg-[#efeae2]">
          {/* Dynamic Island */}
          <div className="absolute top-2 left-1/2 z-10 flex h-5 w-24 -translate-x-1/2 items-center justify-end rounded-full bg-black px-2 shadow-inner">
            <span className="size-2 rounded-full bg-[#1a2b23] ring-1 ring-emerald-500/40" />
          </div>

          <header className="flex items-center gap-3 bg-gradient-to-r from-[#075e54] to-[#008069] px-4 pt-9 pb-3.5 text-white shadow-sm">
            <span className="relative flex size-9 items-center justify-center rounded-full bg-white/20 text-sm font-bold ring-2 ring-white/25">
              {p.initial}
              <span className="absolute end-0 bottom-0 size-2.5 rounded-full bg-[#25d366] ring-2 ring-[#075e54]" />
            </span>
            <div className="flex-1 leading-tight">
              <p className="text-sm font-semibold">{p.contact}</p>
              <p className="text-[11px] text-white/85">{p.online}</p>
            </div>
            <Video className="size-4.5 opacity-90" />
          </header>

          <div
            className="space-y-2.5 px-3 py-4"
            style={{ backgroundImage: 'radial-gradient(rgba(0,0,0,0.04) 1px, transparent 1px)', backgroundSize: '14px 14px' }}
          >
            {variant === 'full' ? (
              <>
                <Bubble time="10:21" at={200}>
                  {p.question}
                </Bubble>
                <Bubble out time="10:21" at={500}>
                  <span className="flex items-center gap-2">
                    <span className="flex size-7 items-center justify-center rounded-full bg-[#00a884] text-white shadow-xs">
                      <Play className="size-3.5 fill-current" />
                    </span>
                    <span className="flex h-6 flex-1 items-center gap-0.5">
                      {[6, 12, 18, 9, 14, 20, 8, 16, 11, 6, 13, 9].map((h, i) => (
                        <span key={i} className="w-0.5 rounded-full bg-[#00a884]/75" style={{ height: h }} />
                      ))}
                    </span>
                    <Mic className="size-3.5 text-[#00a884]" />
                  </span>
                </Bubble>
                <Bubble out time="10:22" at={800}>
                  <span className="flex items-center gap-2.5 rounded-lg bg-black/[0.04] p-2">
                    <span className="flex size-9 items-center justify-center rounded-md bg-[#e5484d] text-[10px] font-bold text-white shadow-xs">PDF</span>
                    <span className="leading-tight">
                      <span className="block text-xs font-semibold">{p.pdfName}</span>
                      <span className="block text-[10px] text-[#667781]">{p.pdfMeta}</span>
                    </span>
                    <FileText className="ms-auto size-4 text-[#667781]" />
                  </span>
                </Bubble>
                <Bubble out time="10:22" className="w-[78%] p-1.5" at={1100}>
                  <span className="relative block h-24 overflow-hidden rounded-lg bg-[#dfe9d8]">
                    <span
                      className="absolute inset-0"
                      style={{
                        backgroundImage:
                          'linear-gradient(115deg, transparent 46%, #fff 46%, #fff 52%, transparent 52%), linear-gradient(20deg, transparent 60%, #f5f0e1 60%, #f5f0e1 66%, transparent 66%), linear-gradient(160deg, transparent 30%, #c9dcef 30%, #c9dcef 42%, transparent 42%)',
                      }}
                    />
                    <MapPin className="absolute top-1/2 left-1/2 size-6 -translate-x-1/2 -translate-y-full animate-bounce fill-[#e5484d] text-white" />
                  </span>
                  <span className="block px-1.5 pt-1.5 text-xs font-medium">{p.location}</span>
                </Bubble>
                <Bubble time="10:24" at={1400}>
                  {p.thanks}
                </Bubble>
              </>
            ) : (
              p.mini.map((text, i) => (
                <Bubble key={text} out={i === 1} time={`10:3${i}`} at={200 + i * 350}>
                  {text}
                </Bubble>
              ))
            )}
          </div>

          <footer className="flex items-center gap-2 bg-[#f0f2f5] px-3 py-2.5">
            <span className="flex-1 rounded-full bg-white px-4 py-2 text-[13px] text-[#8696a0] shadow-2xs">{p.placeholder}</span>
            <span className="flex size-10 items-center justify-center rounded-full bg-[#00a884] text-white shadow-sm">
              <Send className="size-4 rtl:-scale-x-100" />
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}
