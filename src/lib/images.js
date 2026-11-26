// Compression des images à l'envoi : économise les forfaits de données et supprime les métadonnées (position GPS, appareil)
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function optimize(file, { max = 1280, quality = 78, format = 'webp' } = {}) {
  const out = file.path.replace(/\.[a-z]+$/i, '') + (format === 'webp' ? '.webp' : '.jpg');
  // L'image est lue en mémoire : aucun fichier ne reste ouvert pendant l'écriture du résultat
  // (sous Windows, réécrire un fichier encore ouvert par sharp échoue, par exemple .jpg → .jpg).
  const input = await fs.readFile(file.path);
  const img = sharp(input, { failOn: 'error' }).rotate().resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true });
  const buf = format === 'webp' ? await img.webp({ quality }).toBuffer() : await img.jpeg({ quality, mozjpeg: true }).toBuffer();
  await fs.writeFile(out, buf);
  if (out !== file.path) await fs.rm(file.path, { force: true });
  file.path = out;
  file.filename = path.basename(out);
  return file;
}
