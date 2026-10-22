import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('药品收藏详情');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
