// Камера: поток задней камеры, живая проверка кадра в рамке, снимок; загрузка файла как запасной путь.

import { liveCheck } from './quality.js';

export const MAX_SIDE = 1024;          // сторона кадра для анализа: точности хватает, считается < 1 с
const GUIDE = { left: 0.10, top: 0.30, width: 0.80, height: 0.40 };   // как .guide в app.css
const MARGIN = 0.15;                   // запас вокруг рамки при снимке

let stream = null;

export async function startCamera(video) {
  if (!window.isSecureContext) throw Object.assign(new Error('https'), { code: 'https' });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('none'), { code: 'none' });
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    throw Object.assign(e, { code: e.name === 'NotAllowedError' ? 'denied' : 'none' });
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
}

export function stopCamera() {
  if (stream) for (const tr of stream.getTracks()) tr.stop();
  stream = null;
}

/** Прямоугольник рамки в пикселях видео (учитывает object-fit: cover). */
function guideRect(video, margin = 0) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const ew = video.clientWidth, eh = video.clientHeight;
  const scale = Math.max(ew / vw, eh / vh);
  const ox = (ew - vw * scale) / 2, oy = (eh - vh * scale) / 2;
  const gx = GUIDE.left * ew, gy = GUIDE.top * eh, gw = GUIDE.width * ew, gh = GUIDE.height * eh;
  let x = (gx - margin * gw - ox) / scale, y = (gy - margin * gh - oy) / scale;
  let w = (gw * (1 + 2 * margin)) / scale, h = (gh * (1 + 2 * margin)) / scale;
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(vw - x, w); h = Math.min(vh - y, h);
  return { x, y, w, h };
}

/** Живая проверка: уменьшенный кадр рамки → статусы света, резкости, века. null — видео ещё не готово. */
export function checkFrame(video, small) {
  if (!video.videoWidth) return null;
  const r = guideRect(video);
  const W = 160, H = Math.max(40, Math.round((W * r.h) / r.w));
  small.width = W; small.height = H;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, W, H);
  return liveCheck(ctx.getImageData(0, 0, W, H));
}

/** Снимок области рамки с запасом → canvas не больше MAX_SIDE. */
export function capture(video, canvas) {
  const r = guideRect(video, MARGIN);
  const k = Math.min(1, MAX_SIDE / Math.max(r.w, r.h));
  canvas.width = Math.round(r.w * k); canvas.height = Math.round(r.h * k);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Фото из файла (галерея или нативная камера) → canvas не больше MAX_SIDE. Поворот по EXIF делает браузер. */
export function loadFile(file, canvas) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.round(img.naturalWidth * k); canvas.height = Math.round(img.naturalHeight * k);
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}
