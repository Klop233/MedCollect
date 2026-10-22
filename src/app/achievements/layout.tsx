import { privatePageMetadata } from '@/lib/site';

export const metadata = privatePageMetadata('收集成就');

export default function PrivateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
