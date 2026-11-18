import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';
import { bad } from './http.js';

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
export const publicDir = path.join(config.storageDir, 'public');
export const privateDir = path.join(config.storageDir, 'private');
fs.mkdirSync(path.join(publicDir, 'listings'), { recursive: true });
fs.mkdirSync(path.join(privateDir, 'kyc'), { recursive: true });

const make = (sub, base) => multer({
  storage: multer.diskStorage({
    destination: path.join(base, sub),
    filename: (_req, file, cb) => cb(null, crypto.randomUUID() + EXT[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => (EXT[file.mimetype] ? cb(null, true) : cb(bad('Seules les images JPEG, PNG ou WebP sont acceptées.', 'file_type'))),
});
export const listingUpload = make('listings', publicDir);
export const kycUpload = make('kyc', privateDir);
export const removeFile = (p) => { if (p) fs.rm(p, { force: true }, () => {}); };
