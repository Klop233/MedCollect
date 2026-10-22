import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('个人空间');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
