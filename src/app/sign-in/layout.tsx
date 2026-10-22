import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('登录');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
