// Compression des images à l'envoi : économise les forfaits de données et supprime les métadonnées (position GPS, appareil)
import sharp from 'sharp';
import fs from 'node:fs/promises';

export async function optimize(file, { max = 1280, quality = 78, format = 'webp' } = {}) {
  const out = file.path.replace(/\.[a-z]+$/i, '') + (format === 'webp' ? '.webp' : '.jpg');
  const img = sharp(file.path, { failOn: 'error' }).rotate().resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
  const buf = format === 'webp' ? await img.webp({ quality }).toBuffer() : await img.jpeg({ quality, mozjpeg: true }).toBuffer();
  await fs.writeFile(out, buf);
  if (out !== file.path) await fs.rm(file.path, { force: true });
  file.path = out;
  file.filename = out.split('/').pop();
  return file;
}
