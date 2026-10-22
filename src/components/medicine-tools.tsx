'use client';
import { useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, Tag, Trash2, LoaderCircle, ChevronDown, Palette } from 'lucide-react';
import { request, levelNames, type Medicine } from './ui-types';
import { ErrorNotice } from './shell';

async function photoBlob(file: File): Promise<Blob> {
  if (file.size > 15 * 1024 * 1024) throw new Error('原图不能超过15MB，请先裁切图片');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const ratio = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('浏览器无法处理图片');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .86));
    if (!blob || blob.size > 5 * 1024 * 1024) throw new Error('处理后的封面仍超过5MB，请选择更小的图片');
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lineHeight: number, maxLines = 3) {
  const lines: string[] = []; let line = '';
  for (const c of text) { if (ctx.measureText(line + c).width > width && line) { lines.push(line); line = c; } else line += c; }
  if (line) lines.push(line);
  lines.slice(0, maxLines).forEach((v, i) => ctx.fillText(i === maxLines - 1 && lines.length > maxLines ? v.slice(0, -1) + '…' : v, x, y + i * lineHeight));
}

export function MedicineTools({ medicine, onChange }: { medicine: Medicine; onChange: () => Promise<void> | void }) {
  const input = useRef<HTMLInputElement>(null), [label, setLabel] = useState((medicine.tags || []).join('，'));
  const savedTags = (medicine.tags || []).join('，');
  useEffect(() => { setLabel(savedTags); }, [savedTags]);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function action(kind: string, work: () => Promise<void>) { if (busy) return; setBusy(kind); setError(''); setNotice(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(''); } }
  async function upload(file?: File) {
    if (!file) return;
    await action('cover', async () => { const blob = await photoBlob(file), form = new FormData(); form.set('file', blob, 'cover.jpg'); await request(`/api/medicines/${medicine.id}/cover`, { method: 'PUT', body: form }); await onChange(); setNotice('封面已保存，仅当前账号可见。'); });
    if (input.current) input.current.value = '';
  }
  async function share() {
    await action('share', async () => {
      await document.fonts.ready;
      const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1440;
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('浏览器不支持生成分享卡');
      ctx.fillStyle = '#f7f8f2'; ctx.fillRect(0, 0, 1080, 1440); ctx.fillStyle = '#e6eddb'; ctx.fillRect(60, 170, 960, 670);
      if (medicine.hasCover) { const image = new Image(); image.src = `/api/medicines/${medicine.id}/cover?v=${encodeURIComponent(medicine.coverUpdatedAt || medicine.updatedAt)}`; await image.decode(); const scale = Math.max(960 / image.naturalWidth, 670 / image.naturalHeight); ctx.save(); ctx.beginPath(); ctx.rect(60,170,960,670); ctx.clip(); ctx.drawImage(image, 60 + (960-image.naturalWidth*scale)/2,170+(670-image.naturalHeight*scale)/2,image.naturalWidth*scale,image.naturalHeight*scale); ctx.restore(); }
      else { ctx.save(); ctx.translate(540,500); ctx.rotate(-.55); ctx.fillStyle='#7d9c73';ctx.beginPath();ctx.roundRect(-230,-90,460,180,90);ctx.fill();ctx.fillStyle='#cbd9b8';ctx.beginPath();ctx.roundRect(-230,-90,230,180,[90,0,0,90]);ctx.fill();ctx.restore(); }
      ctx.fillStyle='#24694e';ctx.font='600 34px Arial, sans-serif';ctx.fillText('MedCollect · 我的药品图鉴',60,110);
      ctx.font='600 48px Arial, Microsoft YaHei, sans-serif';wrap(ctx,medicine.genericName,60,930,960,65,2);
      ctx.font='400 105px Georgia,serif';const mass = medicine.totalGrams.length > 14 ? medicine.totalGrams.slice(0,14)+'…' : medicine.totalGrams;ctx.fillText(mass+' g',60,1140);
      ctx.font='28px Arial, sans-serif';ctx.fillText('有效成分收藏 · '+(levelNames[medicine.level]||'典藏')+' Lv.'+medicine.level,65,1205);
      ctx.strokeStyle='#cdd8c2';ctx.beginPath();ctx.moveTo(60,1280);ctx.lineTo(1020,1280);ctx.stroke();ctx.fillStyle='#64725b';ctx.font='24px Arial, sans-serif';ctx.fillText('收藏是记录，而非囤积。仅为个人收藏，不作药品验真。',60,1340);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('分享卡生成失败');download(blob,'medcollect-share.png');setNotice('分享卡已生成，不含追溯码、邮箱和批次；不会自动公开发布。');
    });
  }
  return <details className="collection-tools"><summary className="tools-summary"><span className="tools-summary-icon"><Palette size={19}/></span><span><b>自定义这张图鉴</b><small>标签、封面与分享卡</small></span><ChevronDown size={19}/></summary><div className="tools-body"><div className="tags-editor"><label className="field"><span><Tag size={16}/> 标签分组</span><input maxLength={180} value={label} onChange={e=>setLabel(e.target.value)} placeholder="最多8个，用逗号分隔，例如：抽屉、已有药盒" /></label><button className="button secondary" disabled={!!busy} onClick={()=>void action('tags',async()=>{await request(`/api/medicines/${medicine.id}/tags`,{method:'PATCH',body:JSON.stringify({tags:label.split(/[,，]/).map(t=>t.trim()).filter(Boolean)})});await onChange();setNotice('标签已更新。');})}>保存标签</button></div><div className="tool-buttons"><input ref={input} className="visually-hidden" type="file" accept="image/*" aria-label="选择图鉴封面" onChange={e=>void upload(e.target.files?.[0])}/><button className="button secondary" disabled={!!busy} onClick={()=>input.current?.click()}><ImagePlus size={17}/>{medicine.hasCover?'更换封面':'添加封面'}</button>{medicine.hasCover&&<button className="button secondary" disabled={!!busy} onClick={()=>void action('remove',async()=>{await request(`/api/medicines/${medicine.id}/cover`,{method:'DELETE'});await onChange();setNotice('封面已移除。');})}><Trash2 size={17}/>移除封面</button>}<button className="button primary" disabled={!!busy} onClick={()=>void share()}>{busy==='share'?<LoaderCircle className="spin" size={17}/>:<Download size={17}/>}下载分享卡</button></div><p className="tools-note">照片会先缩小并去除位置等元数据后私有保存。分享卡仅本机生成；如果封面照片本身含有个人信息，请先裁切。</p>{error&&<ErrorNotice message={error}/>}{notice&&<div className="notice positive" role="status">{notice}</div>}</div></details>;
}
