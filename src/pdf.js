import fs from 'node:fs/promises';

/*
 * A minimal PDF writer for /pdf: one A4 page per JPEG, the image fitted and centered.
 * PDF embeds JPEG data as is (the DCTDecode filter), so nothing is decoded or re-encoded and
 * no library is needed. Pages are portrait, or landscape for landscape images.
 */

const A4 = [595.28, 841.89]; // points (1/72 inch)
const MARGIN = 18; // a quarter inch, so printers don't cut the image

/** Width, height and color components of a JPEG, from its SOF marker; null if it isn't a usable JPEG. */
export function jpegInfo(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = buffer.readUInt16BE(i + 5);
      const width = buffer.readUInt16BE(i + 7);
      const components = buffer[i + 9];
      return width && height ? { width, height, components } : null;
    }
    if (marker === 0xda || marker === 0xd9) return null; // image data before any SOF
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  return null;
}

/** True if the PDF can embed this JPEG as is (grayscale or RGB; CMYK JPEGs come out inverted in some readers). */
export const embeddable = (info) => info !== null && (info.components === 1 || info.components === 3);

/** Writes the JPEG files to `outFile` as a PDF, one page each, in order. */
export async function buildPdf(jpegFiles, outFile) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const write = (data) => {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    chunks.push(buffer);
    length += buffer.length;
  };
  const object = (id, body) => {
    offsets[id] = length;
    write(`${id} 0 obj\n`);
    for (const part of [body].flat()) write(part);
    write('\nendobj\n');
  };

  write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const pageIds = [];
  // Objects 1 and 2 are the catalog and the page tree; each page takes 3 more.
  for (const [n, file] of jpegFiles.entries()) {
    const jpeg = await fs.readFile(file);
    const info = jpegInfo(jpeg);
    if (!embeddable(info)) throw new Error(`Not an embeddable JPEG: ${file}`);
    const [imageId, contentId, pageId] = [3 + n * 3, 4 + n * 3, 5 + n * 3];
    pageIds.push(pageId);

    const [pageW, pageH] = info.width > info.height ? [A4[1], A4[0]] : A4;
    const scale = Math.min((pageW - 2 * MARGIN) / info.width, (pageH - 2 * MARGIN) / info.height);
    const [w, h] = [info.width * scale, info.height * scale];
    const [x, y] = [(pageW - w) / 2, (pageH - h) / 2];

    object(imageId, [
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
        `/ColorSpace /${info.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      '\nendstream',
    ]);
    const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;
    object(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
  }
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

  const count = 3 + jpegFiles.length * 3;
  const xref = length;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  await fs.writeFile(outFile, Buffer.concat(chunks));
  return outFile;
}
