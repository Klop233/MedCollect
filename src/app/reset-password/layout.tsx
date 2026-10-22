import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('重置密码');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
