import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('找回密码');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
