const MAX_AVATAR_FILE_SIZE = 50_000_000;
const MAX_AVATAR_DATA_URL_SIZE = 512_000;
const AVATAR_MAX_DIMENSION = 512;

export async function optimizeAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/'))
    throw new Error('Choose or paste an image file for the avatar.');
  if (file.size > MAX_AVATAR_FILE_SIZE)
    throw new Error('Avatar image is too large to process. Maximum original file size is 50 MB.');

  const source = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the avatar image.'));
    };
    image.src = url;
  });
  const scale = Math.min(
    1,
    AVATAR_MAX_DIMENSION / Math.max(source.naturalWidth, source.naturalHeight),
  );
  let width = Math.max(1, Math.round(source.naturalWidth * scale));
  let height = Math.max(1, Math.round(source.naturalHeight * scale));
  const canvas = document.createElement('canvas');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process the avatar image.');
    context.drawImage(source, 0, 0, width, height);
    for (const quality of [0.86, 0.72, 0.58]) {
      const avatar = canvas.toDataURL('image/webp', quality);
      if (avatar.length <= MAX_AVATAR_DATA_URL_SIZE) return avatar;
    }
    width = Math.max(1, Math.round(width * 0.75));
    height = Math.max(1, Math.round(height * 0.75));
  }
  throw new Error('Could not optimize the avatar image enough to save it.');
}
