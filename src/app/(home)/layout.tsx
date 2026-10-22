import type { Metadata } from 'next';
import { SITE_URL, socialOpenGraph } from '@/lib/site';

// Canonical belongs to this route only, never to authenticated collection pages.
export const metadata: Metadata = {
  alternates: { canonical: `${SITE_URL}/` },
  openGraph: { ...socialOpenGraph, url: `${SITE_URL}/` },
};

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
