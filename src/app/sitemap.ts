import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  // Never enumerate user-specific medicine IDs or authentication URLs.
  return [{ url: `${SITE_URL}/`, changeFrequency: 'monthly', priority: 1 }];
}
