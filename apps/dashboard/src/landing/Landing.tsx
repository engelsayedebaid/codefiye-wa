import { useEffect, useState } from 'react';
import { Brand, Icon, type IconName } from '../ui';
import { codeSamples, egp, plans, nav } from './content';

const APP = '/app';
const DOCS = `${import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '')}/docs`;

/** Adds `.in` to `.reveal` elements when they scroll into view. */
function useReveal() {
  useEffect(() => {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')), { threshold: 0.05 });
    document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function ProductPreview() {
  return <div className="product-scene" aria-label="مثال توضيحي لواجهة المنتج، ليس بيانات فعلية">
    <div className="scene-label"><span className="live-dot" /> من أول رسالة، كل شيء تحت السيطرة <small>عرض توضيحي</small></div>
    <div className="product-window">
      <div className="window-top"><span className="window-dots"><i /><i /><i /></span><span dir="ltr">app.wa-platform / overview</span><Icon name="shield" size={14} /></div>
      <div className="preview-body"><div className="preview-side"><span className="brand-symbol"><Icon name="chat" /></span>{(['grid', 'phone', 'chat', 'key', 'settings'] as IconName[]).map((name) => <span key={name}><Icon name={name} size={18} /></span>)}</div>
        <div className="preview-main"><div className="row-between"><div><small>مساحة العمل</small><h3>متجرك، أقرب لعملائك.</h3></div><span className="avatar">م</span></div>
          <div className="preview-metrics"><div><small>الجلسات المتصلة</small><strong>٠١ <span>/ ٠٣</span></strong></div><div><small>الرسائل اليوم</small><strong>٢٤٨</strong></div><div><small>نسبة التسليم</small><strong>٩٨٪</strong></div></div>
          <div className="preview-chart"><div className="row-between"><strong>نشاط الرسائل</strong><small>آخر ٧ أيام</small></div><div className="bars">{[32, 52, 40, 72, 62, 85, 100].map((h, i) => <span key={i} style={{ height: `${h}%` }} />)}</div><div className="chart-labels"><span>السبت</span><span>الإثنين</span><span>الأربعاء</span><span>الجمعة</span></div></div>
          <div className="preview-session"><span className="icon-tile"><Icon name="phone" /></span><div><strong>خدمة العملاء</strong><small dir="ltr">+20 10 •••• 4821</small></div><span className="badge success">متصلة</span></div>
        </div>
      </div>
    </div>
    <div className="floating-message"><span className="icon-tile"><Icon name="check" /></span><div><strong>وصلت رسالتك.</strong><small>مرحباً سارة، طلبك في الطريق إليك.</small></div><span dir="ltr">10:24</span></div>
    <div className="floating-code" dir="ltr"><span>POST</span> /api/send-message <b>202</b></div>
  </div>;
}

export function PricingCards({ compact = false }: { compact?: boolean }) {
  return <div className={`pricing-grid ${compact ? 'compact-pricing' : ''}`}>{plans.map((plan) => <article className={`price-card ${plan.highlight ? 'featured' : ''}`} key={plan.name}>
    <div className="price-header"><span className="plan-name">{plan.name}</span>{plan.highlight && <span className="badge success">اختيار الفرق النامية</span>}</div>
    <p>{plan.tagline}</p><div className="price-amount"><strong>{egp(plan.egp)}</strong><span>ج.م<small>شهرياً</small></span></div>
    <div className="plan-sessions"><Icon name="phone" />{plan.sessions === 1 ? 'رقم واتساب واحد' : `${egp(plan.sessions)} أرقام واتساب`}</div>
    <ul>{['إدارة الجلسات وربط QR', 'مفاتيح API خاصة بك', 'سجل الرسائل وحالة التسليم'].map((f) => <li key={f}><Icon name="check" size={17} />{f}</li>)}</ul>
    <a className={`button ${plan.highlight ? 'primary' : 'secondary'}`} href={compact ? '/app/billing' : '/app/register'}>ابدأ مع {plan.name}<Icon name="arrow" size={17} /></a>
  </article>)}</div>;
}

const features: { icon: IconName; title: string; text: string; tag: string }[] = [
  { icon: 'phone', title: 'رقمك الحالي. إمكانيات جديدة.', text: 'اربط جهازك برمز QR أو رمز الربط، وتابع حالة كل جلسة من مكان واحد.', tag: 'إدارة الجلسات' },
  { icon: 'code', title: 'من فكرتك إلى أول رسالة.', text: 'REST API واضح وأمثلة كود بلغتك المفضّلة. بدون تغيير طريقة عمل فريقك.', tag: 'مصمّم للمطوّرين' },
  { icon: 'shield', title: 'صلاحيات واضحة، وبيانات محمية.', text: 'مفاتيح مستقلة وجلسات مشفّرة، مع عزل بيانات كل مساحة عمل.', tag: 'الأمان أولاً' },
];
const questions = [
  ['هل أحتاج رقماً جديداً؟', 'يمكنك ربط رقمك الحالي من الأجهزة المرتبطة في واتساب. ننصح برقم احتياطي أثناء تجربة التكامل.'],
  ['كيف أرسل أول رسالة؟', 'أنشئ جلسة من لوحة التحكم، امسح رمز QR، ثم استخدم مفتاح الجلسة مع POST /api/send-message.'],
  ['هل الأسعار بالجنيه المصري؟', 'نعم، الأسعار المعروضة بالجنيه المصري. الاشتراك المدفوع سيتاح بعد إكمال ربط بوابة الدفع؛ لا يتم تحصيل أي مبلغ حالياً.'],
  ['هل الخدمة رسمية من Meta؟', 'لا، المنصة مستقلة وتستخدم بروتوكول WhatsApp Web. قد يتوقف الاتصال أو يُحظر الرقم؛ استخدمها فقط مع عملاء وافقوا على التواصل.'],
];

export function Landing() {
  useReveal();
  const [menu, setMenu] = useState(false);
  const [tab, setTab] = useState(1);
  const [copy, setCopy] = useState('نسخ الكود');
  const sample = codeSamples[tab]!;
  return <div className="marketing">
    <div className="announcement">بُنيت للمطوّرين. صُمّمت لتقريبك من عملائك.<a href="#code">اكتشف الـ API <Icon name="arrow" size={14} /></a></div>
    <header className="site-header"><div className="site-container nav-inner"><Brand /><nav className={menu ? 'open' : ''} aria-label="التنقل الرئيسي">{nav.map((item) => <a key={item.href} href={item.href} onClick={() => setMenu(false)}>{item.label}</a>)}<a href={DOCS}>التوثيق</a></nav><div className="header-actions"><a className="text-link" href={APP}>تسجيل الدخول</a><a className="button primary" href="/app/register">ابدأ الآن<Icon name="arrow" size={16} /></a><button className="icon-button mobile-menu" onClick={() => setMenu(!menu)} aria-label="القائمة" aria-expanded={menu}><Icon name={menu ? 'close' : 'menu'} /></button></div></div></header>
    <main>
      <section className="site-container hero-section"><div className="hero-copy"><span className="eyebrow"><span className="live-dot" /> واتساب، متصل بأعمالك</span><h1>محادثات أقرب.<br /><span>إمكانيات أكبر.</span></h1><p>حوّل واتساب إلى جزء من منتجك. أرسل الرسائل، اربط أرقام فريقك، وتابع محادثاتك من منصة واحدة بسيطة.</p><div className="hero-actions"><a className="button primary large" href="/app/register">ابدأ رحلتك الآن<Icon name="arrow" /></a><a className="button secondary large" href="#how">كيف تعمل المنصة؟</a></div><div className="hero-points"><span><Icon name="check" size={16} />رقمك الحالي</span><span><Icon name="check" size={16} />واجهة عربية</span><span><Icon name="check" size={16} />API موحّد</span></div></div><ProductPreview /></section>
      <div className="integration-strip site-container"><span>يعمل مع أدواتك،<br /><strong>لا بدلاً منها.</strong></span><div dir="ltr">Node.js <i /> Python <i /> PHP <i /> HTTP / REST</div><a href={DOCS}>استعرض التوثيق<Icon name="arrow" size={17} /></a></div>
      <section className="site-container section-space reveal" id="features"><div className="section-heading"><span className="eyebrow">أقل تعقيداً. أكثر اتصالاً.</span><h2>كل ما تحتاجه لتبدأ محادثة أفضل.</h2><p>أدوات واضحة، بدون ازدحام. ركّز على تجربة عميلك واترك إدارة الاتصال للمنصة.</p></div><div className="feature-grid">{features.map((f) => <article className="feature-card" key={f.title}><span className="icon-tile"><Icon name={f.icon} size={26} /></span><small>{f.tag}</small><h3>{f.title}</h3><p>{f.text}</p></article>)}</div></section>
      <section className="how-section" id="how"><div className="site-container section-space"><div className="section-heading"><span className="eyebrow">من البداية لأول رسالة</span><h2>ثلاث خطوات. والباقي محادثات.</h2></div><div className="steps-grid">{[['اربط رقم واتساب', 'أنشئ جلسة وامسح QR من هاتفك. رقمك أصبح جاهزاً.'], ['جهّز مفتاحك', 'انسخ مفتاح API الخاص بالجلسة واحفظه بأمان.'], ['أرسل أول رسالة', 'من لوحة التحكم أو من تطبيقك، وراقب حالة الإرسال.']].map(([title, text], i) => <article key={title}><span className="step-number">0{i + 1}</span><h3>{title}</h3><p>{text}</p></article>)}</div></div></section>
      <section className="site-container section-space developer-section reveal" id="code"><div><span className="eyebrow">مصمّم ليُبنى عليه</span><h2>فكرتك تستحق<br />تكاملاً أبسط.</h2><p>طلب HTTP واحد يربط تطبيقك بعملائك. اختر اللغة التي تعرفها، واستعرض العقود الفعلية في توثيق الـ API.</p><a className="button secondary" href={DOCS}>افتح توثيق المطوّرين<Icon name="code" /></a></div><div className="code-window"><div className="code-tabs" dir="ltr">{codeSamples.map((s, i) => <button key={s.id} className={tab === i ? 'active' : ''} onClick={() => setTab(i)} aria-pressed={tab === i}>{s.label}</button>)}<button onClick={async () => { try { await navigator.clipboard.writeText(sample.code); setCopy('تم النسخ'); } catch { setCopy('تعذّر النسخ'); } }} aria-label="نسخ الكود"><Icon name="copy" size={16} /></button></div><pre dir="ltr"><code>{sample.code}</code></pre><div className="code-footer"><span>POST /api/send-message</span><span role="status">{copy}</span></div></div></section>
      <section className="pricing-section" id="pricing"><div className="site-container section-space"><div className="section-heading centered"><span className="eyebrow">أسعار تناسب مرحلة نموّك</span><h2>مساحة لكل فريق. وسعر واضح.</h2><p>اختر عدد الأرقام المناسب لعملك. جميع الأسعار بالجنيه المصري.</p><span className="badge neutral">الخطط المقترحة · تفعيل الدفع قريباً</span></div><PricingCards /><div className="pricing-note"><Icon name="shield" size={18} />لا يتم تحصيل رسوم حالياً. ستظهر تفاصيل الدفع قبل تفعيل أي اشتراك.</div></div></section>
      <section className="site-container section-space faq-section reveal" id="faq"><div><span className="eyebrow">نحن هنا للتوضيح</span><h2>أسئلة صغيرة.<br />إجابات واضحة.</h2><p>تفاصيل تساعدك تبدأ على أساس صحيح.</p></div><div className="faq-list">{questions.map(([q, a]) => <details key={q}><summary>{q}<Icon name="plus" size={19} /></summary><p>{a}</p></details>)}</div></section>
      <section className="site-container final-cta"><div><span className="eyebrow">ابدأ بمحادثة واحدة</span><h2>خلّي المسافة بينك وبين عميلك أقصر.</h2><p>كل جلسة جديدة، فرصة لتواصل أفضل.</p></div><a className="button primary large" href="/app/register">افتح مساحة عملك<Icon name="arrow" /></a></section>
    </main>
    <footer className="site-container footer"><div><Brand /><p>البنية البسيطة وراء محادثات أفضل.</p></div><div className="footer-links"><a href="#features">المزايا</a><a href="#pricing">الأسعار</a><a href={DOCS}>التوثيق</a><a href={APP}>لوحة التحكم</a></div><div className="footer-bottom"><span>© {new Date().getFullYear()} wa-platform</span><span>خدمة مستقلة، غير تابعة لـ WhatsApp أو Meta.</span></div></footer>
  </div>;
}
