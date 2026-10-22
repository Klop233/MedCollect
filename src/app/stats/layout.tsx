import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('收藏统计');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
