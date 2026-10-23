'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Camera, ImagePlus, Keyboard, ScanLine, ArrowRight, ArrowUpRight, Check, X, Info, RotateCcw, LoaderCircle, ShieldCheck } from 'lucide-react';
import { Shell, PageHeading, ErrorNotice } from '@/components/shell';
import { CollectionForm } from '@/components/collection-form';
import { Modal } from '@/components/modal';
import { request, type Lookup, type Box, type Medicine } from '@/components/ui-types';
import { lookupLocally } from '@/lib/local-lookup';
import type { IScannerControls } from '@zxing/browser';

export default function ScanPage() {
  const [input, setInput] = useState('');
  const [code, setCode] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [camera, setCamera] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [continuous,setContinuous]=useState(false);
  const [recent,setRecent]=useState<{box:Box;duplicate:boolean;medicine:Medicine}[]>([]);
  const [batchNotice,setBatchNotice]=useState('');
  const [undoing,setUndoing]=useState('');
  const [success, setSuccess] = useState<{ box: Box; duplicate: boolean; medicine: Medicine } | null>(null);
  const controls = useRef<IScannerControls | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const starting = useRef(false);
  const mounted = useRef(true);
  const scanGeneration = useRef(0);
  function stop() {
    scanGeneration.current += 1;
    controls.current?.stop(); controls.current = null;
    const stream = video.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach(t => t.stop());
    if (video.current) video.current.srcObject = null;
    if (mounted.current) { setCamera(false); setCameraStarting(false); }
    starting.current = false;
  }
  useEffect(() => { mounted.current = true; const onVisibility = () => { if (document.hidden) stop(); }; document.addEventListener('visibilitychange', onVisibility); return () => { mounted.current = false; stop(); document.removeEventListener('visibilitychange', onVisibility); }; }, []);
  async function identify(raw: string, format?: string) {
    stop(); setError(''); setSuccess(null); let value = raw.normalize('NFKC').trim();
    if (/^[\d\s]+$/.test(value)) value = value.replace(/\s/g, '');
    if (/^https?:\/\//i.test(value) || !/^[A-Za-z0-9._+\-/=]{1,200}$/.test(value)) { setError('这是网址或暂不支持的码内容。为保证安全，不会自动打开或访问它；请手动输入包装上的纯追溯码。'); return; }
    if (format === 'EAN_13' || format === 'EAN_8' || format === 'UPC_A' || format === 'UPC_E' || (/^\d+$/.test(value) && [8, 12, 13, 14].includes(value.length))) { setError('识别到可能的商品条码。它不能唯一识别这一盒，请扫描旁边的药品追溯码。'); return; }
    setInput(value); setCode(value); setLookup(null); setBusy(true);
    try {
      // 请求先由浏览器发给本机服务（不经过云端、不需要密钥）；本机这条路走不通才回退到 Worker。
      const local = await lookupLocally(value);
      setLookup(local ?? await request<Lookup>('/api/trace/lookup', { method: 'POST', body: JSON.stringify({ code: value, format }) }));
    } catch (e) { setError(e instanceof Error ? e.message : '查询失败'); setLookup({ status: 'failed', message: '查询暂时失败，你仍可以手动补全信息。' }); } finally { setBusy(false); }
  }
  async function startCamera() {
    if (starting.current) return;
    setError(''); setSuccess(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setError('相机需要 HTTPS 或本机 localhost 环境。请使用相册识别、手输，或在系统浏览器的 HTTPS 页面重试。'); return; }
    starting.current = true; setCamera(true); setCameraStarting(true); const generation = ++scanGeneration.current;
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (generation !== scanGeneration.current || !mounted.current) return;
      const hints = new Map(); hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8]);
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 250 });
      const target = video.current;
      if (!target) throw new Error('扫描窗口未能打开，请重试');
      const resultControls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, target, (result, _error, scanControls) => {
        if (!result || generation !== scanGeneration.current) return;
        scanControls.stop(); void identify(result.getText(), BarcodeFormat[result.getBarcodeFormat()]);
      });
      if (generation !== scanGeneration.current || !mounted.current) { resultControls.stop(); const stream = target.srcObject as MediaStream | null; stream?.getTracks().forEach(t => t.stop()); return; }
      controls.current = resultControls; setCameraStarting(false); starting.current = false;
    } catch (e) { if (generation === scanGeneration.current) { stop(); setError(e instanceof DOMException && e.name === 'NotAllowedError' ? '未获得相机权限。请在浏览器设置中允许访问，或使用相册识别。' : e instanceof Error ? `相机暂不可用：${e.message}` : '无法打开相机，请使用相册识别或手动输入。'); } }
  }
  async function decodePhoto(file?: File) {
    if (!file) return; stop(); setError('');
    if (file.size > 15 * 1024 * 1024) { setError('图片超过15MB，请选择较小或裁切后的图片。'); if (upload.current) upload.current.value = ''; return; }
    setBusy(true);
    const url = URL.createObjectURL(file);
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
      const hints = new Map(); hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8]); hints.set(DecodeHintType.TRY_HARDER, true);
      const result = await new BrowserMultiFormatReader(hints).decodeFromImageUrl(url);
      await identify(result.getText(), BarcodeFormat[result.getBarcodeFormat()]);
    } catch { setError('未能从图片中识别到清晰的码。请裁切到追溯码附近、避免反光，或手动输入。'); } finally { URL.revokeObjectURL(url); setBusy(false); if (upload.current) upload.current.value = ''; }
  }
  function saved(result: {box:Box;duplicate:boolean;medicine:Medicine}) {
    if(!result.duplicate)setRecent(items=>items.some(i=>i.box.id===result.box.id)?items:[result,...items]);
    if(continuous){stop();setCode('');setLookup(null);setInput('');setSuccess(null);setError('');setBatchNotice(result.duplicate?'该码已收藏，不重复增加克数。':result.box.genericName+' 已保存，可以继续录入下一盒。');}
    else setSuccess(result);
  }
  async function undo(item: {box:Box}){if(undoing)return;setUndoing(item.box.id);try{await request('/api/boxes/'+item.box.id,{method:'DELETE'});setRecent(items=>items.filter(i=>i.box.id!==item.box.id));setBatchNotice('已撤销本页新建的记录。');}catch(e){setError(e instanceof Error?e.message:'撤销失败');}finally{setUndoing('');}}
  function reset() { stop(); setCode(''); setLookup(null); setSuccess(null); setError(''); setInput(''); }
  return <Shell><PageHeading eyebrow="A SMALL SCAN, A NEW DISCOVERY" title="遇见，扫码，收藏。" description="找到药盒上的追溯码，为你的图鉴添上新的一页。" /><ol className="scan-steps" aria-label="收藏流程"><li className={!code && !success ? 'current' : 'complete'} aria-current={!code && !success ? 'step' : undefined}><span>01</span>识别追溯码</li><li className={code && !success ? 'current' : success ? 'complete' : ''} aria-current={code && !success ? 'step' : undefined}><span>02</span>核对信息</li><li className={success ? 'current' : ''} aria-current={success ? 'step' : undefined}><span>03</span>加入图鉴</li></ol><div className="batch-toolbar"><label><input type="checkbox" checked={continuous} onChange={e=>setContinuous(e.target.checked)}/>连续录入模式</label><span>每盒仍需确认；保存后准备下一盒，相机由你点击开启。</span><b>本页新增 {recent.length} 份</b></div>{batchNotice&&<div className="notice positive" role="status">{batchNotice}</div>}<div className="scan-layout"><aside className="scan-guide"><div className="scan-guide-symbol"><ScanLine size={36} strokeWidth={1.2} /></div><h2>把药盒的故事<br />收进图鉴里。</h2><p>追溯码是每盒药的独立标识。请扫描药盒上的一维追溯码或二维码，而不是通用商品条码。</p><ol><li><span>01</span><div><b>识别追溯码</b><small>相机、相册或手动输入</small></div></li><li><span>02</span><div><b>核对药名与质量</b><small>查询不到时，也可以手动补全</small></div></li><li><span>03</span><div><b>留下一份收藏</b><small>按每种药的有效成分克数成长</small></div></li></ol><div className="scan-privacy"><ShieldCheck size={17} /><span>相机画面和图片仅在本机识别，查询只发送码值。</span></div></aside><section className="scan-panel">
      {success ? <div className="save-success"><span className="success-mark"><Check size={36} strokeWidth={1.6} /></span><div className="eyebrow muted">{success.duplicate ? 'ALREADY IN YOUR COLLECTION' : 'A NEW PAGE IN YOUR ARCHIVE'}</div><h2>{success.duplicate ? '这份收藏，已经在图鉴里了' : '收藏成功，又一份美好记录。'}</h2><p>{success.box.genericName}<br />{success.duplicate ? '同一追溯码不会重复增加克数。' : success.box.massGrams === null ? '已点亮图鉴，质量可稍后补充。' : `本次记录 ${success.box.massGrams} g 有效成分。`}</p><Link className="button primary" href={`/medicines/${success.box.medicineId}`}>查看这张图鉴<ArrowUpRight size={17} /></Link><button type="button" className="button secondary" onClick={reset}><RotateCcw size={16} />继续扫描</button></div> : <>
      {!code && <><div className="panel-heading"><span className="eyebrow muted">START YOUR COLLECTION</span><h2>选择一种录入方式</h2></div><div className="scan-methods"><button type="button" onClick={() => void startCamera()} disabled={cameraStarting || busy}><Camera size={25} strokeWidth={1.5} /><b>相机扫码</b><small>打开后置摄像头</small></button><button type="button" onClick={() => upload.current?.click()} disabled={busy}><ImagePlus size={25} strokeWidth={1.5} /><b>相册识别</b><small>选择清晰的药盒照片</small></button></div><input ref={upload} type="file" accept="image/*" className="visually-hidden" aria-label="选择追溯码图片" onChange={e => void decodePhoto(e.target.files?.[0])} /><div className="divider-label"><span />或者手动输入<span /></div><form className="manual-code" onSubmit={e => { e.preventDefault(); void identify(input); }}><label className="field"><span><Keyboard size={15} />药品追溯码</span><input autoComplete="off" spellCheck={false} required maxLength={200} placeholder="请输入包装上的追溯码" value={input} onChange={e => setInput(e.target.value)} /></label><button type="submit" className="button primary" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}识别并继续</button></form><div className="notice quiet"><Info size={17} /><span>没有查询权限或未查到时，可以自己填写药名和克数，收藏仍然可用。</span></div></>}
      {camera && <Modal className="camera-modal" label="扫描药品追溯码" onClose={stop}><div className="camera-window"><div className="camera-top"><span>对准药品追溯码</span><button type="button" aria-label="关闭相机" onClick={stop}><X size={22} /></button></div><video ref={video} muted playsInline autoPlay /><div className="camera-crosshair"><span /><span /><span /><span /></div><div className="camera-hint">{cameraStarting ? '正在打开摄像头…' : '保持平稳，避免反光，识别后会自动停止'}</div></div></Modal>}
      {error && <ErrorNotice message={error} />}{code && <><div className="identified-code"><div><span className="eyebrow muted">TRACE CODE</span><strong>{code}</strong></div><button type="button" className="text-button" onClick={reset}>重新扫描</button></div>{busy ? <div className="lookup-loading"><LoaderCircle size={25} className="spin" /><p>正在查询药品信息…</p></div> : lookup && <><div className={`notice ${lookup.status === 'found' ? 'positive' : 'quiet'}`}><Info size={18} /><span>{lookup.message}{lookup.status === 'found' && ' 查询结果仅供核对，不代表药品验真。'}</span></div>{lookup.status === 'failed' && <button type="button" className="button secondary" onClick={() => void identify(code)}>重新查询</button>}<CollectionForm key={code} traceCode={code} candidate={lookup.candidate} onSaved={saved} /></>}</>}
      </>}
    </section></div>{recent.length>0&&<section className="batch-history"><div className="section-title"><div><div className="eyebrow muted">THIS PAGE SESSION</div><h2>本页新加入的收藏</h2></div></div><p className="tools-note">刷新后仅清空此列表，不会删除已保存的收藏。撤销只作用于本页新建的记录。</p>{recent.map(item=><div className="batch-item" key={item.box.id}><Link href={`/medicines/${item.box.medicineId}`}><strong>{item.box.genericName}</strong><small>{item.box.massGrams===null?'待补质量':item.box.massGrams+' g'}</small></Link><button type="button" className="text-button danger" disabled={!!undoing} onClick={()=>void undo(item)}>撤销本次</button></div>)}</section>}</Shell>;
}
