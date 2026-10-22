import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('验证邮箱');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
