'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, BarChart3, CalendarDays, Tag, ScanLine } from 'lucide-react';
import { Shell, PageHeading, ErrorNotice } from '@/components/shell';
import { request, levelNames, type Medicine } from '@/components/ui-types';

type Stats = {
  medicineCount: number;
  boxCount: number;
  pendingCount: number;
  tagCount: number;
  activeDays: number;
  monthly: { month: string; boxCount: number; medicineCount: number }[];
  topMedicines: Medicine[];
};

export default function StatisticsPage() {
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      setData(await request<Stats>('/api/stats'));
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    }
  }

  useEffect(() => { void load(); }, []);
  const max = Math.max(1, ...(data?.monthly.map(m => m.boxCount) || []));
  const tiles = data ? [
    { icon: BarChart3, label: '已点亮图鉴', value: data.medicineCount, unit: '种' },
    { icon: ScanLine, label: '收藏记录', value: data.boxCount, unit: '份' },
    { icon: CalendarDays, label: '有记录的日期', value: data.activeDays, unit: '天' },
    { icon: Tag, label: '已用标签', value: data.tagCount, unit: '个' },
  ] : [];

  return (
    <Shell>
      <PageHeading
        eyebrow="A COLLECTION IN PERSPECTIVE"
        title="把记录，连成自己的轨迹。"
        description="只统计你当前保留的收藏；不同药的克数不会合并计算成就。"
        action={<Link className="button primary" href="/scan"><ScanLine size={17} />继续收藏</Link>}
      />
      {error ? (
        <ErrorNotice message={error} retry={() => void load()} />
      ) : !data ? (
        <p className="loading-note">正在整理收藏统计…</p>
      ) : (
        <>
          <section className="stat-tiles" aria-label="收藏统计概览">
            {tiles.map(({ icon: Icon, label, value, unit }) => (
              <div key={label}>
                <span className="stats-tile-icon"><Icon size={21} strokeWidth={1.7} aria-hidden="true" /></span>
                <span className="stat-tile-label">{label}</span>
                <strong className="stat-tile-value">{value}<span className="stat-tile-unit">{unit}</span></strong>
              </div>
            ))}
          </section>

          <div className="statistics-layout">
            <section className="statistics-panel statistics-chart-panel">
              <div className="section-title">
                <div>
                  <div className="eyebrow muted">LAST SIX MONTHS</div>
                  <h2>近六个月的记录</h2>
                </div>
                <span>按上海时区统计</span>
              </div>
              <div className="month-chart" role="img" aria-label={data.monthly.map(m => `${m.month}收藏${m.boxCount}份`).join('；')}>
                {data.monthly.map(m => (
                  <div className={`month-column${m.boxCount === 0 ? ' month-column-empty' : ''}`} key={m.month}>
                    <strong>{m.boxCount}</strong>
                    <div className="month-bar-space">
                      <div style={{ height: `${m.boxCount / max * 100}%`, minHeight: m.boxCount === 0 ? 0 : undefined }} />
                    </div>
                    <span>{m.month.slice(5)}月</span>
                    <small>{m.medicineCount}种</small>
                  </div>
                ))}
              </div>
              {!data.boxCount && (
                <p className="tools-note">还没有记录。从手边已有的药盒开始，不必为了统计数字额外购药。</p>
              )}
            </section>

            <section className="statistics-panel statistics-medicines-panel">
              <div className="section-title">
                <div>
                  <div className="eyebrow muted">EVERY MEDICINE, ITS OWN SCALE</div>
                  <h2>各药的独立积累</h2>
                </div>
              </div>
              <div className="stats-medicines">
                {data.topMedicines.length ? data.topMedicines.map(m => (
                  <Link href={`/medicines/${m.id}`} key={m.id}>
                    <div className="stats-medicine-info">
                      <strong>{m.genericName}</strong>
                      <div className="stats-medicine-meta">
                        <span>{m.boxCount} 份收藏{m.pendingCount > 0 && ` · ${m.pendingCount} 份待补质量`}</span>
                        <span className="level-pill">{levelNames[m.level] || '典藏'} · Lv.{m.level}</span>
                      </div>
                      <div className="progress-track stats-medicine-progress" aria-hidden="true">
                        <span style={{ width: `${m.progress}%` }} />
                      </div>
                      <small>{m.nextThreshold ? `下一阶段 ${m.nextThreshold} g` : '全部质量阶段已点亮'}</small>
                    </div>
                    <b>{m.totalGrams}<span>g</span></b>
                    <ArrowUpRight size={17} aria-hidden="true" />
                  </Link>
                )) : (
                  <p className="tools-note">点亮第一种药后，这里会显示该药的克数。</p>
                )}
              </div>
              <Link className="text-button" href="/?pending=1">
                查看待补质量的 {data.pendingCount} 份记录<ArrowUpRight size={15} />
              </Link>
            </section>
          </div>
        </>
      )}
    </Shell>
  );
}
