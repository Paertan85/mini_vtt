// Encodes images to PNG off the DM window's thread; png.ts is its page side.
//
// In a page, Chromium encodes a canvas (toBlob, convertToBlob) only in idle
// time, and since Electron 42 that can take a second to come, so a revealed
// room reached the players a second late. A worker has no idle time to wait
// for: it encodes at once.
//
// Gets { id, bitmap } with the bitmap handed over, and answers { id, blob } or
// { id, error }.

addEventListener('message', (event: MessageEvent<{ id: number; bitmap: ImageBitmap }>) => {
  const { id, bitmap } = event.data;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('bitmaprenderer');
  if (!context) {
    // Encoding the empty canvas would turn a fog mask into a revealed map
    bitmap.close();
    postMessage({ id, error: 'No bitmap renderer for the PNG' });
    return;
  }
  context.transferFromImageBitmap(bitmap);
  canvas.convertToBlob({ type: 'image/png' }).then(
    (blob) => postMessage({ id, blob }),
    (err: unknown) => postMessage({ id, error: String(err) }),
  );
});
