'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Pill, ArrowUpRight, ArrowLeft, LoaderCircle, MailCheck, ShieldCheck, Check, Mail } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { CapsuleArt, ErrorNotice } from './shell';

type AuthKind = 'sign-in' | 'sign-up' | 'verify-email' | 'forgot-password' | 'reset-password';
const copy = { 'sign-in': { eyebrow: 'WELCOME BACK TO YOUR COLLECTION', title: '你的收藏，等你回来。', detail: '登录账户，继续书写自己的药品收藏图鉴。' }, 'sign-up': { eyebrow: 'YOUR FIRST PAGE STARTS HERE', title: '给收藏，一个自己的家。', detail: '创建邮箱账户，把每一份记录妥善保存。' }, 'verify-email': { eyebrow: 'ONE LAST SMALL STEP', title: '确认邮箱，开启收藏。', detail: '打开验证邮件中的链接，完成邮箱验证。' }, 'forgot-password': { eyebrow: 'LET’S FIND YOUR WAY BACK', title: '找回通往图鉴的钥匙。', detail: '输入注册邮箱，我们将发送密码重置链接。' }, 'reset-password': { eyebrow: 'A FRESH START', title: '换一把新的钥匙。', detail: '设置新密码后，所有设备需要重新登录。' } };
export function AuthForm({ kind }: { kind: AuthKind }) {
  const text = copy[kind];
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [token, setToken] = useState('');
  const [verified, setVerified] = useState(false);
  useEffect(() => { const params = new URLSearchParams(window.location.search); setEmail(params.get('email') || ''); setToken(params.get('token') || ''); const err = params.get('error'); if (err) setError(kind === 'reset-password' ? '重置链接无效或已过期，请重新申请。' : '验证链接无效或已过期，请重新发送验证邮件。'); if (params.get('verified') === 'true' || params.get('verified') === '1') setVerified(true); }, [kind]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      if ((kind === 'sign-up' || kind === 'reset-password') && password !== repeat) throw new Error('两次输入的密码不一致。');
      if (kind === 'sign-in') { const result = await authClient.signIn.email({ email, password, callbackURL: '/' }); if (result.error) throw new Error(result.error.code === 'EMAIL_NOT_VERIFIED' ? '邮箱尚未验证，请先查看验证邮件，或点击下方重新发送。' : '登录失败，请核对邮箱、密码及验证状态。'); window.location.assign('/'); }
      else if (kind === 'sign-up') { const result = await authClient.signUp.email({ name, email, password, callbackURL: '/verify-email?verified=true' }); if (result.error) throw new Error(result.error.message || '注册失败，请稍后重试'); window.location.assign(`/verify-email?email=${encodeURIComponent(email)}`); }
      else if (kind === 'verify-email') { const result = await authClient.sendVerificationEmail({ email, callbackURL: '/verify-email?verified=true' }); if (result.error) throw new Error(result.error.message || '验证邮件发送失败'); setNotice('验证邮件已发送，请检查收件箱和垃圾邮件。'); }
      else if (kind === 'forgot-password') { const result = await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' }); if (result.error) throw new Error(result.error.message || '重置邮件请求失败'); setNotice('如果该邮箱已注册，你会收到密码重置邮件。请检查收件箱和垃圾邮件。'); }
      else { if (!token) throw new Error('重置链接缺少令牌，请重新申请找回密码。'); const result = await authClient.resetPassword({ newPassword: password, token }); if (result.error) throw new Error('重置链接无效或已过期，请重新申请。'); setNotice('密码已重置，原有登录已失效。请使用新密码登录。'); setPassword(''); setRepeat(''); }
    } catch (e) { setError(e instanceof Error ? e.message : '操作暂未完成，请重试'); } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-story"><Link href="/" className="brand"><span className="brand-mark"><Pill size={24} /></span><span>MedCollect<small>药品收藏图鉴</small></span></Link><div className="auth-story-main"><span className="eyebrow">A PERSONAL ARCHIVE, A GENTLE RITUAL</span><h1>小小的药盒，<br />也有值得<br /><em>留下的故事。</em></h1><p>扫描、记录、慢慢积累。<br />把每一种收藏，变成独一无二的图鉴。</p><CapsuleArt large /></div><div className="auth-story-bottom"><span>SCAN. COLLECT. GROW.</span><span>YOUR STORY, IN GRAMS.</span></div></section><section className="auth-main"><Link className="back-link" href="/"><ArrowLeft size={16} />返回图鉴</Link><div className="auth-form-wrap"><div className="auth-mobile-brand"><Pill size={26} /><span>MedCollect</span></div><div className="eyebrow muted">{text.eyebrow}</div><h2>{verified ? '邮箱已确认，欢迎加入。' : text.title}</h2><p className="auth-description">{verified ? '现在可以登录，开始记录你的第一份收藏。' : text.detail}</p>
      {verified ? <div className="auth-verified"><span><MailCheck size={42} strokeWidth={1.4} /></span><p>邮箱验证完成</p><Link href="/sign-in" className="button primary full-width">前往登录<ArrowUpRight size={17} /></Link></div> : <><form className="auth-form" onSubmit={submit}>{kind === 'verify-email' && <div className="mail-illustration"><MailCheck size={41} strokeWidth={1.2} /><span>还没收到邮件？确认邮箱后可以重新发送。</span></div>}{kind === 'sign-up' && <label className="field">收藏者昵称<input autoComplete="nickname" required minLength={1} maxLength={40} placeholder="给自己起一个名字" value={name} onChange={e => setName(e.target.value)} /></label>}{kind !== 'reset-password' && <label className="field">邮箱地址<input type="email" autoComplete="email" required maxLength={254} placeholder="your@email.com" value={email} onChange={e => setEmail(e.target.value)} /></label>}{(kind === 'sign-in' || kind === 'sign-up' || kind === 'reset-password') && <label className="field"><span>{kind === 'reset-password' ? '新密码' : '登录密码'}{kind === 'sign-in' && <Link href="/forgot-password">忘记密码？</Link>}</span><input type="password" required minLength={kind === 'sign-in' ? 1 : 8} maxLength={128} autoComplete={kind === 'sign-in' ? 'current-password' : 'new-password'} placeholder={kind === 'sign-in' ? '输入你的密码' : '至少8个字符'} value={password} onChange={e => setPassword(e.target.value)} /></label>}{(kind === 'sign-up' || kind === 'reset-password') && <label className="field">再次确认密码<input type="password" required minLength={8} maxLength={128} autoComplete="new-password" placeholder="再输入一次密码" value={repeat} onChange={e => setRepeat(e.target.value)} /></label>}{error && <ErrorNotice message={error} />}{notice && <div className="notice positive" role="status"><Check size={17} /><span>{notice}</span></div>}{!(kind === 'reset-password' && notice) && <button className="button primary full-width" type="submit" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : kind === 'verify-email' || kind === 'forgot-password' ? <Mail size={18} /> : null}{busy ? '请稍候…' : kind === 'sign-in' ? '登录我的收藏册' : kind === 'sign-up' ? '创建账户并发送验证邮件' : kind === 'verify-email' ? '重新发送验证邮件' : kind === 'forgot-password' ? '发送重置邮件' : '确认设置新密码'}<ArrowUpRight size={17} /></button>}</form><div className="auth-switch">{kind === 'sign-in' ? <>还没有收藏账户？<Link href="/sign-up">创建一个</Link><Link className="resend-link" href={`/verify-email${email ? `?email=${encodeURIComponent(email)}` : ''}`}>重新发送验证邮件</Link></> : kind === 'sign-up' ? <>已经有账户？<Link href="/sign-in">直接登录</Link></> : <Link href="/sign-in">返回登录</Link>}</div></>}
      <p className="auth-security"><ShieldCheck size={15} />邮箱验证后才能登录，收藏记录仅你自己可见。</p><p className="auth-footnote">仅用于药品收藏记录，不提供用药建议或药品验真。</p>
    </div><div className="auth-copyright">© {new Date().getFullYear()} MedCollect <span>用记录，让收藏有迹可循。</span></div></section></main>;
}
