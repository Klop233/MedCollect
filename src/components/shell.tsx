'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen, ScanLine, Award, UserRound, ArrowUpRight, Pill, ShieldCheck, BarChart3 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import type { ReactNode } from 'react';

const navigation = [{ href: '/', label: '我的图鉴', short: '图鉴', icon: BookOpen }, { href: '/scan', label: '扫描收藏', short: '扫码', icon: ScanLine }, { href: '/achievements', label: '收集成就', short: '成就', icon: Award }, { href: '/stats', label: '收藏统计', short: '统计', icon: BarChart3 }, { href: '/me', label: '个人空间', short: '我的', icon: UserRound }];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const isActive = (href: string) => pathname === href || (href === '/' && pathname.startsWith('/medicines/'));
  const mobileNavigation = [navigation[0], navigation[3], navigation[1], navigation[2], navigation[4]];
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <header className="site-header"><div className="header-inner">
      <Link className="brand" href="/" aria-label="MedCollect 首页"><span className="brand-mark"><Pill size={23} strokeWidth={1.8} /></span><span>MedCollect<small>药品收藏图鉴</small></span></Link>
      <nav className="desktop-nav" aria-label="主导航">{navigation.map(({ href, label, icon: Icon }) => <Link key={href} href={href} aria-current={isActive(href) ? 'page' : undefined} className={isActive(href) ? 'active' : ''}><Icon size={16} />{label}</Link>)}</nav>
      <Link className="account-chip" aria-label={session ? '打开我的收藏账户' : '登录或注册'} href={session ? '/me' : '/sign-in'}><span>{session?.user.name?.slice(0, 1) || <UserRound size={17} />}</span><b>{session ? '我的收藏账户' : '登录 / 注册'}</b><ArrowUpRight size={15} /></Link>
    </div></header>
    <main id="main-content" className="main-container" tabIndex={-1}>{children}</main>
    <footer className="site-footer"><span><Pill size={14} /> MEDCOLLECT · 留下每一份收藏</span><span><ShieldCheck size={14} />仅记录收藏，不提供用药建议或药品验真</span></footer>
    <nav className="bottom-nav" aria-label="手机导航">{mobileNavigation.map(({ href, short, icon: Icon }) => <Link key={href} href={href} aria-current={isActive(href) ? 'page' : undefined} className={`${isActive(href) ? 'active' : ''} ${href === '/scan' ? 'nav-scan' : ''}`}><span className="nav-icon"><Icon size={21} strokeWidth={1.8} /></span><span>{short}</span></Link>)}</nav>
  </div>;
}

export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow"><span />{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div role="alert" className="notice error"><span>{message}</span>{retry && <button type="button" className="text-button" onClick={retry}>重试</button>}</div>;
}

export function LoadingCards() {
  return <div className="medicine-grid" aria-label="正在加载收藏">{[1, 2, 3].map(i => <div className="skeleton-card" key={i}><div /><span /><span /></div>)}</div>;
}

export function CapsuleArt({ large = false }: { large?: boolean }) {
  return <div className={large ? 'capsule-art large' : 'capsule-art'} aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-spark spark-one">+</div><div className="art-spark spark-two">+</div><div className="art-capsule"><span /><span /></div><div className="art-dot dot-one" /><div className="art-dot dot-two" /></div>;
}
