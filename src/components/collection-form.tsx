'use client';
import { useMemo, useState } from 'react';
import { Check, ArrowUpRight, ChevronDown, Info, LoaderCircle } from 'lucide-react';
import Decimal from 'decimal.js';
import { request, type Box, type Candidate, type Medicine } from './ui-types';
import { ErrorNotice } from './shell';

export function CollectionForm({ traceCode, candidate, existing, onSaved, onCancel, defaultTags = [] }: { traceCode: string; candidate?: Candidate; existing?: Box; onSaved: (result: { box: Box; duplicate: boolean; medicine: Medicine }) => void; onCancel?: () => void; defaultTags?: string[] }) {
  const [genericName, setGenericName] = useState(existing?.genericName || candidate?.genericName || '');
  const [manufacturer, setManufacturer] = useState(existing?.manufacturer || candidate?.manufacturer || '');
  const [specification, setSpecification] = useState(existing?.specification || candidate?.specification || '');
  const [batchNumber, setBatchNumber] = useState(existing?.batchNumber || candidate?.batchNumber || '');
  const [expiresAt, setExpiresAt] = useState(existing?.expiresAt?.slice(0, 10) || candidate?.expiresAt?.slice(0, 10) || '');
  const [notes, setNotes] = useState(existing?.notes || '');
  const [mode, setMode] = useState<'pending' | 'total' | 'unit'>(existing ? existing.massGrams === null ? 'pending' : 'total' : candidate?.suggestedMass ? 'unit' : 'pending');
  const [value, setValue] = useState(existing?.massGrams || candidate?.suggestedMass?.value || '');
  const [unit, setUnit] = useState<'g' | 'mg' | 'ug'>(existing ? 'g' : candidate?.suggestedMass?.unit || 'mg');
  const [quantity, setQuantity] = useState(candidate?.suggestedMass?.quantity || '');
  const [basis, setBasis] = useState(existing?.massBasis || candidate?.suggestedMass?.basis || '');
  const [tagText, setTagText] = useState(defaultTags.join('，'));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const preview = useMemo(() => {
    try { if (mode === 'pending' || !value) return null; let mass = new (Decimal.clone({ precision: 64 }))(value); if (!mass.isFinite() || mass.lte(0)) return null; if (mode === 'unit') { if (!quantity || !new Decimal(quantity).isInteger() || new Decimal(quantity).lte(0)) return null; mass = mass.mul(quantity).div(unit === 'mg' ? 1000 : unit === 'ug' ? 1000000 : 1); } return mass.toFixed(); } catch { return null; }
  }, [mode, value, quantity, unit]);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError('');
    if (!confirmed) { setError('请先确认药名及有效成分质量信息。'); return; }
    if (mode !== 'pending' && !preview) { setError('请输入有效的正数质量和包装数量。'); return; }
    setBusy(true);
    try {
      const result = await request<{ box: Box; duplicate: boolean; medicine: Medicine }>(existing ? `/api/boxes/${existing.id}` : '/api/boxes', { method: existing ? 'PATCH' : 'POST', body: JSON.stringify({ traceCode, genericName, ...(tagText.trim() || existing ? { tags: tagText.split(/[,，]/).map(t => t.trim()).filter(Boolean) } : {}), manufacturer, specification, batchNumber, expiresAt, notes, source: existing?.source || (candidate ? 'api' : 'manual'), mass: mode === 'pending' ? { mode } : { mode, value, ...(mode === 'unit' ? { unit, quantity } : {}), basis } }) });
      onSaved(result);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  }
  return <form onSubmit={save} className="collection-form"><div className="form-section-heading"><span>01</span><div><h3>确认药品信息</h3><p>同一通用药名会归入同一张图鉴。</p></div></div><div className="field-grid"><label className="field full"><span>通用药名 <em aria-hidden="true">*</em></span><input required maxLength={120} placeholder="例如：布洛芬片" value={genericName} onChange={e => { setGenericName(e.target.value); setConfirmed(false); }} /></label><label className="field">生产厂家<input maxLength={200} placeholder="选填" value={manufacturer} onChange={e => setManufacturer(e.target.value)} /></label><label className="field">包装 / 制剂规格<input maxLength={300} placeholder="如：0.2g × 24片" value={specification} onChange={e => { setSpecification(e.target.value); setConfirmed(false); }} /></label></div>
    <label className="field full tag-entry">图鉴标签<input value={tagText} onChange={e=>{setTagText(e.target.value);setConfirmed(false);}} maxLength={180} placeholder="可选，逗号分隔，最多8个标签" /></label><div className="form-section-heading"><span>02</span><div><h3>记录有效成分质量</h3><p>不含辅料、包装，不是药效换算。</p></div></div><div className="segmented-control mass-mode"><button type="button" aria-pressed={mode === 'pending'} className={mode === 'pending' ? 'selected' : ''} onClick={() => { setMode('pending'); setConfirmed(false); }}>暂不填写</button><button type="button" aria-pressed={mode === 'unit'} className={mode === 'unit' ? 'selected' : ''} onClick={() => { setMode('unit'); setConfirmed(false); }}>含量 × 数量</button><button type="button" aria-pressed={mode === 'total'} className={mode === 'total' ? 'selected' : ''} onClick={() => { setMode('total'); setConfirmed(false); setValue(''); }}>直接填写克数</button></div>
    {mode === 'pending' ? <div className="notice quiet"><Info size={18} /><span>这份记录仍可点亮图鉴，但暂不参与质量成就。只有 mL、IU 或含量不明确时，请选择待补，不要猜测。</span></div> : <><div className="field-grid mass-fields"><label className="field"><span>{mode === 'unit' ? '单个单位的有效成分含量' : '这盒有效成分总质量（g）'} <em aria-hidden="true">*</em></span><div className="input-unit"><input required inputMode="decimal" maxLength={30} placeholder={mode === 'unit' ? '例如 250' : '例如 6'} value={value} onChange={e => { setValue(e.target.value); setConfirmed(false); }} />{mode === 'unit' ? <select aria-label="有效成分质量单位" value={unit} onChange={e => { setUnit(e.target.value as typeof unit); setConfirmed(false); }}><option value="g">g</option><option value="mg">mg</option><option value="ug">μg</option></select> : <span>g</span>}</div></label>{mode === 'unit' && <label className="field"><span>包装内单位数量 <em aria-hidden="true">*</em></span><input required inputMode="numeric" maxLength={12} placeholder="例如 24（片 / 粒 / 支）" value={quantity} onChange={e => { setQuantity(e.target.value); setConfirmed(false); }} /></label>}<label className="field full"><span>录入依据 <em aria-hidden="true">*</em></span><input required maxLength={500} placeholder={mode === 'unit' ? '如：包装标注每粒250mg，共24粒' : '如：根据各有效成分标注质量求和'} value={basis} onChange={e => { setBasis(e.target.value); setConfirmed(false); }} /></label></div><div className="mass-preview"><span>本次将计入该药收藏</span><strong>{preview || '—'}<small>g</small></strong><span>保存后才会更新成就</span></div></>}
    <details className="more-fields"><summary>添加批次、有效期与备注 <ChevronDown size={16} /></summary><div className="field-grid"><label className="field">生产批次<input maxLength={100} placeholder="选填" value={batchNumber} onChange={e => setBatchNumber(e.target.value)} /></label><label className="field">有效期至<input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} /></label><label className="field full">收藏备注<textarea maxLength={2000} placeholder="留下关于这份收藏的小记录…" value={notes} onChange={e => setNotes(e.target.value)} rows={3} /></label></div></details>
    <label className="confirmation"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} required /><span>{mode === 'pending' ? '我已核对通用药名，知晓该记录暂不计入克数成就。' : '我已核对药名和有效成分质量，确认这不是包装净重或用药剂量建议。'}</span></label>{error && <ErrorNotice message={error} />}<div className="form-actions">{onCancel && <button type="button" className="button secondary" onClick={onCancel}>取消</button>}<button disabled={busy} type="submit" className="button primary">{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}{busy ? '正在保存…' : existing ? '保存更正' : '确认，加入我的图鉴'}<ArrowUpRight size={17} /></button></div>
  </form>;
}
