import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Landing } from './landing/Landing';
import './index.css';

const isApp = window.location.pathname.startsWith('/app');
document.title = isApp ? 'wa-platform · لوحة التحكم' : 'wa-platform · واتساب API منخفض التكلفة للمطوّرين';

createRoot(document.getElementById('root')!).render(<StrictMode>{isApp ? <App /> : <Landing />}</StrictMode>);
