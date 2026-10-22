import type { Metadata } from 'next';

// Public identity only. Keep account data and request parameters out of social metadata.
export const SITE_URL = 'https://med.miolab.ink';
export const SITE_NAME = 'MedCollect · 药品收藏图鉴';
export const SITE_TITLE = 'MedCollect 药品收藏图鉴｜扫码收藏，记录每一克';
export const SITE_DESCRIPTION = '扫描药品追溯码，建立自己的药品收藏图鉴。按每种药的有效成分克数记录成长，整理标签与封面，私密保存收藏。仅作收藏记录，不提供用药建议或药品验真。';

export const socialOpenGraph = {
  type: 'website',
  locale: 'zh_CN',
  siteName: SITE_NAME,
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  images: [{
    url: `${SITE_URL}/social-card.png`,
    width: 1200,
    height: 630,
    type: 'image/png',
    alt: 'MedCollect 药品收藏图鉴：扫码收藏，记录每一克',
  }],
} satisfies Metadata['openGraph'];

export function privatePageMetadata(title: string): Metadata {
  return {
    title,
    // Crawling preferences are not authorization. APIs still enforce server sessions.
    robots: {
      index: false,
      follow: false,
      nocache: true,
      googleBot: { index: false, follow: false, noimageindex: true },
    },
  };
}
