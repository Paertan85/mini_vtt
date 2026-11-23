// The slideshow: pictures from a folder, shown on the player screen one after
// another while the DM gets the next map ready. The main process lists the
// folder and serves each picture by number; this is what both sides share.
//
// Pure functions with no DOM or Node access, like grid.ts.

import { mediaUrlOf } from './media';

/** How long each picture can be shown, in seconds (a setting). */
export const SLIDESHOW_SECONDS = [10, 20, 60] as const;
export const DEFAULT_SLIDESHOW_SECONDS = 20;

/** The most pictures one listing takes from a folder, in name order. */
export const MAX_SLIDESHOW_PICTURES = 500;

/** Listings are named by a short lowercase word: URL hosts are lowercased. */
const LISTING = /^[a-z0-9]{1,16}$/;

export const isSlideshowSeconds = (value: unknown): value is number =>
  SLIDESHOW_SECONDS.includes(value as 10);

export const isListingName = (value: unknown): value is string =>
  typeof value === 'string' && LISTING.test(value);

/** The id the media protocol serves picture `index` of a listing under. */
export const slideshowPictureId = (listing: string, index: number) => `s_${listing}_${index}`;

/** The URL picture `index` of a listing is loaded from. */
export const slideshowPictureUrl = (listing: string, index: number) =>
  mediaUrlOf(slideshowPictureId(listing, index));
