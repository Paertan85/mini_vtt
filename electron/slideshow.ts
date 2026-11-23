// The slideshow folder: pictures the player screen shows one after another
// while the DM gets the next map ready. By default it is the library's own
// slideshow folder; the DM can choose another one.
//
// The folder is listed when the slideshow starts. Only the pictures found
// then are served, by number, so a window never names a file: a picture is
// map-media://s_<listing>_<n> (see src/lib/slideshow.ts).

import path from 'node:path';
import fs from 'node:fs/promises';
import type { SlideshowListing } from '../src/types/map';
import { MAX_SLIDESHOW_PICTURES, slideshowPictureId } from '../src/lib/slideshow';
import { LIBRARY_DIR, mutateIndex, withIndex } from './libraryStore';
import { detectExt, mimeFor, readHeader } from './mediaFiles';

/** The library's own slideshow folder, used until the DM chooses another. */
export const defaultSlideshowFolder = () => path.join(LIBRARY_DIR(), 'slideshow');

/** Enough of a file's start to tell its type (see detectExt). */
const SNIFF_BYTES = 64;

/** The pictures of the latest listing, by id: the only files served for the slideshow. */
let pictures = new Map<string, { file: string; type: string }>();

/** Ids of slideshow pictures start with this; maps and handouts have their own prefixes. */
export const isSlideshowId = (id: string) => id.startsWith('s_');

/** The file and content type of a picture in the latest listing, or null. */
export const slideshowPicture = (id: string) => pictures.get(id) ?? null;

/** Whether `listing` is the latest listing and has `count` pictures. */
export const isCurrentListing = (listing: string, count: number) =>
  pictures.has(slideshowPictureId(listing, 0)) && pictures.size === count && count > 0;

/** The folder the slideshow shows: the one the DM chose, or the library's own. */
export async function slideshowFolder(): Promise<string> {
  const chosen = await withIndex((index) => index.settings.slideshowFolder);
  return chosen ?? defaultSlideshowFolder();
}

/** Keep the folder the DM chose in their folder dialog. */
export async function setSlideshowFolder(folder: string): Promise<void> {
  await mutateIndex((index) => {
    index.settings.slideshowFolder = folder;
  });
}

let lastListing = 0;

/** A new name for each listing, so the windows never show a picture cached from an older one. */
function nextListingName() {
  lastListing = Math.max(Date.now(), lastListing + 1);
  return lastListing.toString(36);
}

/**
 * List the slideshow folder: the images directly in it (not in folders
 * inside it), by their first bytes rather than their names, in name order
 * with numbers counted (2 before 10), up to MAX_SLIDESHOW_PICTURES. The
 * library's own folder is made if it isn't there yet, so the DM can open it.
 */
export async function listSlideshow(folder?: string): Promise<SlideshowListing> {
  const dir = folder ?? (await slideshowFolder());
  if (dir === defaultSlideshowFolder()) await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  let names: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    // A chosen folder that is gone or can't be read: no pictures
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  names.sort(collator.compare);

  const listing = nextListingName();
  const found = new Map<string, { file: string; type: string }>();
  for (const name of names) {
    if (found.size === MAX_SLIDESHOW_PICTURES) break;
    const file = path.join(dir, name);
    try {
      const ext = detectExt(await readHeader(file, SNIFF_BYTES));
      if (!ext || ext === 'webm') continue;
      found.set(slideshowPictureId(listing, found.size), { file, type: mimeFor(ext) });
    } catch {
      // Unreadable: leave it out
    }
  }
  pictures = found;
  return { listing, count: found.size, folderName: path.basename(dir) };
}
