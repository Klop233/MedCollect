import type { Metadata, Viewport } from 'next';
import './globals.css';
import './ui-polish.css';

export const metadata: Metadata = { title: { default: 'MedCollect · 药品收藏图鉴', template: '%s · MedCollect' }, description: '扫描药品追溯码，建立属于你的收藏图鉴。按每种药品的有效成分克数，记录收藏成长。', icons: { icon: '/icon.svg', apple: '/icon.svg' } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f7f8f2' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN" data-scroll-behavior="smooth"><body>{children}</body></html>; }
