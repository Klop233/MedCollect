import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('注册');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
