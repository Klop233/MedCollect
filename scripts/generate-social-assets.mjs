import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// Run locally with `node scripts/generate-social-assets.mjs` after editing the SVG.
// PNGs are committed assets; no image renderer or fonts are required by Workers.
const card = await readFile(new URL('./assets/social-card.svg', import.meta.url));
await sharp(card).png().toFile(fileURLToPath(new URL('../public/social-card.png', import.meta.url)));
const icon = await readFile(new URL('../public/icon.svg', import.meta.url));
for (const [name, size] of [['favicon-32.png', 32], ['favicon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  await sharp(icon).resize(size, size).png().toFile(fileURLToPath(new URL(`../public/${name}`, import.meta.url)));
}
console.log('Generated social-card.png (1200×630), PNG favicons, and Apple touch icon.');
