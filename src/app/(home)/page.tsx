'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Plus, Search, SlidersHorizontal, BookOpen, Layers3, CircleDot, Sparkles, ArrowRight, ScanLine, ChevronDown, X } from 'lucide-react';
import { Shell, CapsuleArt, ErrorNotice, LoadingCards } from '@/components/shell';
import { useAlbum } from '@/components/use-album';
import { levelNames } from '@/components/ui-types';

export default function AlbumPage() {
  const { data, error, loading, refresh } = useAlbum();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('recent');
  const [tag, setTag] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [pending, setPending] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => { setPending(new URLSearchParams(location.search).get('pending') === '1'); }, []);
  const allTags = [...new Set((data?.medicines || []).flatMap(m => m.tags || []))];
  const allManufacturers = [...new Set((data?.medicines || []).flatMap(m => m.manufacturers || []))];
  const filterCount = Number(!!tag) + Number(!!manufacturer) + Number(pending);
  const hasFilters = !!query || filterCount > 0;
  function clearFilters() { setQuery(''); setTag(''); setManufacturer(''); setPending(false); }
  const medicines = useMemo(() => {
    const result = (data?.medicines || []).filter(m => m.genericName.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!tag || m.tags?.includes(tag)) && (!manufacturer || m.manufacturers?.includes(manufacturer)) && (!pending || m.pendingCount > 0));
    if (sort === 'name') result.sort((a, b) => a.genericName.localeCompare(b.genericName, 'zh-CN'));
    return result;
  }, [data, query, sort, tag, manufacturer, pending]);

  return <Shell>
    <section className="album-hero">
      <div className="hero-content">
        <div className="eyebrow"><span />THE PERSONAL COLLECTION</div>
        <h1>把日常，<span>收进图鉴。</span></h1>
        <p>一盒一记录，每一种药都有自己的成长刻度。</p>
        <Link href="/scan" className="button primary hero-button"><ScanLine size={19} />扫描新收藏<ArrowUpRight size={17} /></Link>
        <div className="hero-note"><span className="small-dot" />收藏是记录，而非囤积</div>
      </div>
      <div className="hero-illustration">
        <div className="archive-stamp"><BookOpen size={15} /><span>我的私人收藏册<small>MY LITTLE ARCHIVE</small></span></div>
        <CapsuleArt large />
        <div className="illustration-footer"><span>SCAN · COLLECT · GROW</span><span>每一克，都有迹可循</span></div>
      </div>
    </section>

    <section className="stats-row" aria-label="收藏概览">
      <div><span className="stat-icon"><BookOpen size={20} /></span><div><span className="stat-label">已点亮图鉴</span><strong>{data?.summary.medicineCount ?? '—'}<small>种</small></strong></div><span className="stat-caption">每一种，都是新发现</span></div>
      <div><span className="stat-icon sage"><Layers3 size={20} /></span><div><span className="stat-label">收藏记录</span><strong>{data?.summary.boxCount ?? '—'}<small>份</small></strong></div><span className="stat-caption">每盒独立，认真记录</span></div>
      <div><span className="stat-icon sand"><CircleDot size={20} /></span><div><span className="stat-label">待补质量</span><strong>{data?.summary.pendingCount ?? '—'}<small>份</small></strong></div><span className="stat-caption">补全后计入对应成就</span></div>
    </section>

    <section className="album-section">
      <div className="section-title"><div><div className="eyebrow muted">MY COLLECTION</div><h2>我的药品图鉴<span>{data?.summary.medicineCount ?? '—'}</span></h2></div><Link href="/achievements" className="subtle-link">成长成就<ArrowUpRight size={16} /></Link></div>
      <div className="album-toolbar">
        <label className="search-field"><Search size={18} /><input aria-label="搜索药品名称" placeholder="搜索收藏的药品…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button type="button" className="search-clear" aria-label="清除搜索" onClick={() => setQuery('')}><X size={16} /></button>}</label>
        <label className="sort-field"><select aria-label="图鉴排序" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近收藏</option><option value="name">名称排序</option></select></label>
        <button type="button" className={`filter-toggle ${filtersOpen || filterCount ? 'selected' : ''}`} aria-expanded={filtersOpen} aria-controls="album-filters" onClick={() => setFiltersOpen(v => !v)}><SlidersHorizontal size={17} /><span>筛选</span>{filterCount > 0 && <b>{filterCount}</b>}<ChevronDown size={14} /></button>
      </div>
      <div id="album-filters" className="extended-filters" hidden={!filtersOpen}>
        <label>标签<select aria-label="按标签筛选" value={tag} onChange={e => setTag(e.target.value)}><option value="">全部标签</option>{allTags.map(t => <option key={t}>{t}</option>)}</select></label>
        <label>厂家<select aria-label="按厂家筛选" value={manufacturer} onChange={e => setManufacturer(e.target.value)}><option value="">全部厂家</option>{allManufacturers.map(t => <option key={t}>{t}</option>)}</select></label>
        <label className="pending-filter"><input type="checkbox" checked={pending} onChange={e => setPending(e.target.checked)} />只看待补质量</label>
      </div>
      {hasFilters && <div className="active-filters"><span>找到 {medicines.length} 种</span>{tag && <button type="button" onClick={() => setTag('')} aria-label={`移除标签筛选 ${tag}`}>{tag}<X size={13} /></button>}{manufacturer && <button type="button" onClick={() => setManufacturer('')} aria-label={`移除厂家筛选 ${manufacturer}`}>{manufacturer}<X size={13} /></button>}{pending && <button type="button" onClick={() => setPending(false)}>待补质量<X size={13} /></button>}<button type="button" className="clear-all" onClick={clearFilters}>清除筛选</button></div>}

      {error ? <ErrorNotice message={error} retry={() => void refresh()} /> : loading ? <LoadingCards /> : medicines.length ? <div className="medicine-grid">
        {medicines.map((m, index) => <Link key={m.id} className={`medicine-card card-tone-${index % 3}`} href={`/medicines/${m.id}`}>
          <div className="medicine-art"><span className="card-index">NO. {String(index + 1).padStart(3, '0')}</span>{m.hasCover ? <img className="cover-image" alt={`${m.genericName}的私人封面`} src={`/api/medicines/${m.id}/cover?v=${encodeURIComponent(m.coverUpdatedAt || m.updatedAt)}`} /> : <CapsuleArt />}<span className="art-caption">MEDCOLLECT ARCHIVE</span></div>
          <div className="medicine-card-body">
            <div className="medicine-title"><h3>{m.genericName}</h3><ArrowUpRight size={19} /></div>
            <p>{m.boxCount} 份收藏{m.pendingCount > 0 && <span className="pending-text"> · {m.pendingCount} 份待补质量</span>}</p>
            {!!m.tags?.length && <div className="tag-chips">{m.tags.map(t => <span key={t}>{t}</span>)}</div>}
            <div className="card-mass-row"><div className="mass-number">{m.totalGrams}<span>g</span></div><span className="level-pill"><Sparkles size={12} />{levelNames[m.level] || '典藏'}</span></div>
            <div className="progress-track"><span style={{ width: `${m.progress}%` }} /></div>
            <div className="progress-caption"><span>{m.nextThreshold ? `下一阶段 ${m.nextThreshold} g` : '全部阶段已点亮'}</span><span>{Math.round(m.progress)}%</span></div>
          </div>
        </Link>)}
        <Link href="/scan" className="add-card"><span><Plus size={25} /></span><div><h3>留一个位置，给下一份发现</h3><p>用手边已有的药盒，慢慢填满收藏册</p></div><b>添加收藏<ArrowRight size={16} /></b></Link>
      </div> : <div className="empty-state">
        <div className="empty-icon">{hasFilters ? <Search size={32} strokeWidth={1.4} /> : <><BookOpen size={34} strokeWidth={1.3} /><Sparkles size={17} /></>}</div>
        <span className="eyebrow muted">{hasFilters ? 'A LITTLE MORE EXPLORING' : 'YOUR FIRST CHAPTER'}</span>
        <h3>{hasFilters ? '换个条件，再找找看' : '第一份收藏，会是什么呢？'}</h3>
        <p>{hasFilters ? '暂时没有匹配的药品，试试其他名称或筛选条件。' : '扫描手边药盒的追溯码，点亮属于你的第一张图鉴。\n无需集齐，只记录你实际拥有的收藏。'}</p>
        {hasFilters ? <button type="button" className="button secondary" onClick={clearFilters}>查看全部收藏<ArrowRight size={16} /></button> : <Link href="/scan" className="button primary"><ScanLine size={17} />扫描第一份收藏<ArrowUpRight size={16} /></Link>}
      </div>}
    </section>
    <div className="collection-tip"><Sparkles size={18} /><p><strong>记录已有的美好，不必为了成就额外购药。</strong> 收藏克数仅为图鉴统计，不代表用药量或药效。</p><span>COLLECT MINDFULLY</span></div>
  </Shell>;
}
