const photoTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const maxBytes = 256 * 1024;

export function createProfilePhotos({ api, token, signal, fetchFile = fetch }) {
  const cache = new Map();

  async function download(userId) {
    const { photos } = await api('getUserProfilePhotos', { user_id: userId, limit: 1 });
    const sizes = photos[0]?.filter((size) => (size.file_size ?? 0) <= maxBytes) ?? [];
    const photo = sizes.find((size) => size.width >= 72) ?? sizes.at(-1);
    if (!photo) return null;
    const file = await api('getFile', { file_id: photo.file_id });
    const extension = file.file_path?.match(/^(?:[\w-]+\/)*[\w-]+\.(jpe?g|png|webp)$/i)?.[1];
    if (!extension || (file.file_size ?? 0) > maxBytes) return null;
    const timeout = AbortSignal.timeout(8000);
    const response = await fetchFile(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) return null;
    return `data:${photoTypes[extension.toLowerCase()]};base64,${bytes.toString('base64')}`;
  }

  return (userId) => {
    const saved = cache.get(userId);
    if (saved && saved.expires > Date.now()) return saved.photo;
    cache.delete(userId);
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    const entry = { expires: Date.now() + 15 * 60_000 };
    entry.photo = download(userId).catch(() => {
      entry.expires = Date.now() + 30_000;
      return null;
    });
    cache.set(userId, entry);
    return entry.photo;
  };
}
