// PNG encoding for the DM window, done in a worker (png.worker.ts says why):
// fog masks and effect layers once per change, and the thumbnails the main
// process can't make.
//
// One worker, started by the first encode and kept: an idle worker uses no
// CPU and little memory. A worker that fails is replaced by the next encode.

import PngWorker from './png.worker.ts?worker&inline';

type Job = { resolve: (blob: Blob) => void; reject: (err: Error) => void };

interface Encoder {
  worker: Worker;
  next: number;
  waiting: Map<number, Job>;
}

let encoder: Encoder | null = null;

function startEncoder(): Encoder {
  const started: Encoder = { worker: new PngWorker(), next: 0, waiting: new Map() };
  started.worker.onmessage = (event: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
    const { id, blob, error } = event.data;
    const job = started.waiting.get(id);
    started.waiting.delete(id);
    if (blob) job?.resolve(blob);
    else job?.reject(new Error(error ?? 'Could not encode the PNG'));
  };
  started.worker.onerror = (event) => {
    event.preventDefault();
    if (encoder === started) encoder = null;
    started.worker.terminate();
    const failure = new Error(event.message || 'The PNG encoder stopped');
    started.waiting.forEach((job) => job.reject(failure));
    started.waiting.clear();
  };
  return started;
}

/** Encode a bitmap as a PNG in the worker. The bitmap is handed over: it is closed for the caller. */
export function encodePng(bitmap: ImageBitmap): Promise<Blob> {
  encoder ??= startEncoder();
  const { worker, waiting } = encoder;
  const id = ++encoder.next;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, bitmap }, [bitmap]);
    } catch (err) {
      waiting.delete(id);
      bitmap.close();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** A blob as a data URL. */
export const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the encoded PNG'));
    reader.readAsDataURL(blob);
  });
