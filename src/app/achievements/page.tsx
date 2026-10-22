'use client';
import Link from 'next/link';
import { Award, ArrowUpRight, LockKeyhole, Check, Sparkles } from 'lucide-react';
import Decimal from 'decimal.js';
import { Shell, PageHeading, ErrorNotice, LoadingCards } from '@/components/shell';
import { useAlbum } from '@/components/use-album';
import { levelNames, thresholds } from '@/components/ui-types';

export default function AchievementsPage() {
  const { data, loading, error, refresh } = useAlbum();
  return <Shell><PageHeading eyebrow="SMALL STEPS, MEANINGFUL MILESTONES" title="每一克，都值得记录。" description="每种药品独立累计有效成分质量，收藏的成长，不以盒数衡量。" /><div className="achievement-intro"><div className="achievement-emblem"><Award size={42} strokeWidth={1.3} /></div><div><span className="eyebrow muted">YOUR COLLECTION JOURNEY</span><h2>属于每一种药的成长刻度</h2><p>不同药品不混合累计。待补质量的记录补全后，才会计入对应药品的成就。</p></div><span className="mini-label">按当前收藏计算</span></div>
    {error ? <ErrorNotice message={error} retry={() => void refresh()} /> : loading ? <LoadingCards /> : !data?.medicines.length ? <div className="empty-state"><div className="empty-icon"><Award size={36} strokeWidth={1.3} /></div><h3>第一枚成就，等待你的第一份收藏</h3><p>添加药品并确认克数后，在这里看到它的成长。</p><Link href="/scan" className="button primary">开始记录<ArrowUpRight size={17} /></Link></div> : <div className="achievements-list">{data.medicines.map(m => <section key={m.id} className="achievement-medicine"><div className="achievement-medicine-heading"><div><span className="eyebrow muted">MEDICINE MILESTONES</span><Link href={`/medicines/${m.id}`}><h2>{m.genericName}</h2><ArrowUpRight size={19} /></Link><p>{m.pendingCount ? `${m.pendingCount} 份记录待补质量 · ` : ''}{m.nextThreshold ? `距离下一阶段还差 ${new Decimal(m.nextThreshold).minus(m.totalGrams).toString()} g` : '全部阶段已达成'}</p></div><div className="mass-number">{m.totalGrams}<span>g</span><small>累计有效成分</small></div></div><div className="milestone-row">{thresholds.map((threshold, index) => { const unlocked = m.level >= index + 1; return <div key={threshold} className={`milestone ${unlocked ? 'unlocked' : ''}`}><span className="milestone-icon">{unlocked ? <Award size={30} strokeWidth={1.4} /> : <LockKeyhole size={24} strokeWidth={1.3} />}{unlocked && <i><Check size={10} /></i>}</span><b>{levelNames[index + 1]}</b><strong>{threshold}<span>g</span></strong><small>{unlocked ? '已经点亮' : '等待解锁'}</small></div>; })}</div></section>)}</div>}
    <div className="collection-tip"><Sparkles size={18} /><p>成就依据当前有效收藏动态更新；更正质量或删除记录后，等级也会随之调整。</p></div></Shell>;
}
