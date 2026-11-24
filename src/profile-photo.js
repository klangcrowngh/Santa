const photoTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const maxBytes = 256 * 1024;

export function createProfilePhotos({ api, token, signal, fetchFile = fetch }) {
  const cache = new Map();

  async function download(userId) {
    const { photos } = await api('getUserProfilePhotos', { user_id: userId, limit: 1 });
    const sizes = photos[0]?.filter((size) => (size.file_size ?? 0) <= maxBytes) ?? [];
    const photo = sizes.find((size) => size.width >= 72) ?? sizes.at(-1);
    const fileId = photo?.file_id ?? (await api('getChat', { chat_id: userId }).catch(() => null))?.photo?.small_file_id;
    if (!fileId) {
      console.warn('Фото Telegram: методы профиля и чата не вернули миниатюру.');
      return null;
    }
    const file = await api('getFile', { file_id: fileId });
    const extension = file.file_path?.match(/^(?:[\w-]+\/)*[\w-]+\.(jpe?g|png|webp)$/i)?.[1];
    if (!extension || (file.file_size ?? 0) > maxBytes) throw new Error('Telegram не вернул путь к миниатюре допустимого размера.');
    const timeout = AbortSignal.timeout(8000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      let url = new URL(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await fetchFile(url.href, { redirect: 'manual', signal: requestSignal });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        if (!location) break;
        const next = new URL(location, url);
        const official = next.hostname === 'api.telegram.org' || next.hostname === 'telegram-cdn.org'
          || next.hostname.endsWith('.telegram-cdn.org');
        if (!official || next.protocol !== 'https:') break;
        await response.body?.cancel();
        url = next;
      }
    } catch (error) {
      const reason = String(error.message).replaceAll(token, '[hidden]').replace(/https?:\/\/\S+/g, '[url]');
      throw new Error(`Сбой соединения с Telegram при скачивании миниатюры: ${reason}`);
    }
    if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Telegram не отдал миниатюру (HTTP ${response.status}).`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) throw new Error('Telegram вернул пустую или слишком большую миниатюру.');
    return `data:${photoTypes[extension.toLowerCase()]};base64,${bytes.toString('base64')}`;
  }

  return (userId) => {
    const saved = cache.get(userId);
    if (saved && saved.expires > Date.now()) return saved.photo;
    cache.delete(userId);
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    const entry = { expires: Date.now() + 15 * 60_000 };
    entry.photo = download(userId).catch((error) => {
      console.warn(`Фото Telegram: ${error.message}`);
      entry.expires = Date.now() + 30_000;
      return null;
    });
    cache.set(userId, entry);
    return entry.photo;
  };
}
