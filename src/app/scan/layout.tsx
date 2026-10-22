import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('扫描收藏');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
