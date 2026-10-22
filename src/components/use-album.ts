'use client';
import { useCallback, useEffect, useState } from 'react';
import { request, type Album } from './ui-types';
export function useAlbum() {
  const [data, setData] = useState<Album | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await request<Album>('/api/medicines')); } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { data, error, loading, refresh };
}
