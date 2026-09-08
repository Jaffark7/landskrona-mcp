// Inbäddning av foton i Word-dokument.
//
// En bild i en .docx kräver fyra saker som alla måste stämma överens: filen i paketet,
// en relation i document.xml.rels, en deklarerad innehållstyp, och ett w:drawing med
// måtten angivna i EMU. Saknas något vägrar Word öppna filen, eller visar en tom ruta.

const EMU_PER_CM = 360000;
// A4 minus mallens marginaler. Bredare bilder skalas ned med bevarat sidförhållande.
export const MAX_WIDTH_EMU = 15 * EMU_PER_CM;
export const MAX_HEIGHT_EMU = 20 * EMU_PER_CM;
export const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// Måtten läses ur filhuvudet. Ett bibliotek vore överdrivet för två format, och
// felaktiga mått ger en förvrängd bild snarare än ett fel, så det ska göras rätt.
export function imageSize(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { mime: 'image/png', extension: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      const marker = buffer[offset + 1];
      // SOF0-SOF15 bär bildmåtten. C4, C8 och CC är tabeller, inte ramstart.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', extension: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return null;
}

// Skalar in bilden i tillgänglig yta utan att ändra sidförhållandet.
export function fit(width, height) {
  const scale = Math.min(1, MAX_WIDTH_EMU / (width * 9525), MAX_HEIGHT_EMU / (height * 9525));
  return { cx: Math.round(width * 9525 * scale), cy: Math.round(height * 9525 * scale) };
}

export function drawing(relationId, index, cx, cy, description) {
  const name = `Bild ${index}`;
  const alt = (description || name).replace(/[<>&"]/g, ' ');
  return `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:r><w:drawing>`
    + `<wp:inline xmlns:wp="${NS_WP}" distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${1000 + index}" name="${name}" descr="${alt}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS_A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="${NS_A}"><a:graphicData uri="${NS_PIC}">`
    + `<pic:pic xmlns:pic="${NS_PIC}">`
    + `<pic:nvPicPr><pic:cNvPr id="${1000 + index}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip xmlns:r="${NS_R}" r:embed="${relationId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

// Skriver in filerna, relationerna och innehållstyperna i det renderade paketet.
export function attach(zip, images) {
  if (!images.length) return;
  const relsPath = 'word/_rels/document.xml.rels';
  const typesPath = '[Content_Types].xml';
  let types = zip.file(typesPath).asText();
  let added = '';
  for (const image of images) {
    const target = `media/${image.id}.${image.extension}`;
    zip.file(`word/${target}`, image.buffer);
    added += `<Relationship Id="${image.relationId}" Type="${IMAGE_REL}" Target="${target}"/>`;
    if (!new RegExp(`Extension="${image.extension}"`).test(types)) {
      types = types.replace('<Default ', `<Default Extension="${image.extension}" ContentType="${image.mime}"/><Default `);
    }
  }
  zip.file(typesPath, types);
  zip.file(relsPath, zip.file(relsPath).asText().replace('</Relationships>', added + '</Relationships>'));
}
