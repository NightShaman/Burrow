import { clientBudgets, isWithinAttachmentBudget } from '../../app/clientBudgets';
export { isWithinAttachmentBudget };

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const textTypes = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-ndjson',
]);

/** All browser file reads remain bounded by the configurable attachment budget. */
export async function validatedAttachmentType(file: File): Promise<string> {
  if (file.size > clientBudgets.attachmentFileBytes)
    throw new Error('Attachment exceeds the client file safety budget.');
  const type = file.type.split(';', 1)[0].trim().toLowerCase();
  if (type.startsWith('image/')) {
    if (imageTypes.has(type)) return type;
    throw new Error('Image type is not supported. Use PNG, JPEG, GIF, or WebP.');
  }
  if (type === 'application/pdf') throw new Error('PDF text extraction is not supported.');
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error('Could not read file bytes.'));
    reader.onerror = () => reject(new Error('Could not read file bytes.'));
    reader.onabort = () => reject(new Error('Reading the file was cancelled.'));
    reader.readAsArrayBuffer(file);
  });
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('File is not valid UTF-8 text. Attach a text document or supported image.');
  }
  for (const character of decoded) {
    const code = character.charCodeAt(0);
    if ((code < 32 && ![9, 10, 12, 13].includes(code)) || code === 127)
      throw new Error('File contains binary control bytes, not a text document.');
  }
  return type.startsWith('text/') || textTypes.has(type) ? type : 'text/plain';
}
