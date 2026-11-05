// Video maps: letting go of a video as soon as it leaves the page, and asking
// whether this computer can decode a video in hardware.

import type { VideoCodec } from '../types/map';
import type { Size } from './geometry';

/**
 * Release a video element React is removing (call it from the element's ref
 * callback). Otherwise it keeps its decoder, buffers and open file until it is
 * garbage-collected, and on Windows an open file can't be deleted.
 */
export function releaseVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

const CONTENT_TYPES: Record<VideoCodec, string> = {
  vp8: 'video/webm; codecs="vp8"',
  vp9: 'video/webm; codecs="vp09.00.51.08"',
  av1: 'video/webm; codecs="av01.0.12M.08"',
};

/** Whether this computer decodes `codec` at `size` in hardware. */
export type HardwareCheck = (codec: VideoCodec, size: Size) => Promise<boolean>;

/** Asks Chromium: "power efficient" means a hardware decoder would be used. */
export const decodesInHardware: HardwareCheck = async (codec, size) => {
  try {
    const info = await navigator.mediaCapabilities.decodingInfo({
      type: 'file',
      video: {
        contentType: CONTENT_TYPES[codec],
        width: size.w,
        height: size.h,
        bitrate: 20_000_000,
        framerate: 30,
      },
    });
    return info.supported && info.powerEfficient;
  } catch {
    return true; // Can't tell: say nothing
  }
};

/** Up to this many pixels, decoding in software is fine on most computers. */
const SOFTWARE_OK_PIXELS = 1920 * 1080;
/** Long edges of the sizes to suggest, largest first */
const SUGGESTED_EDGES = [3840, 2560, 1920];

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/**
 * For a video too large for this computer to decode in hardware: the largest
 * common size, same shape, that it does decode in hardware, or the smallest
 * one when it has no hardware decoder for the codec. Null when the video is
 * fine as it is.
 */
export async function smallerVideoSize(
  codec: VideoCodec,
  size: Size,
  check: HardwareCheck = decodesInHardware,
): Promise<Size | null> {
  if (size.w * size.h <= SOFTWARE_OK_PIXELS || (await check(codec, size))) return null;
  const longEdge = Math.max(size.w, size.h);
  let smallest: Size | null = null;
  for (const edge of SUGGESTED_EDGES) {
    if (edge >= longEdge) continue;
    const scale = edge / longEdge;
    smallest = { w: even(size.w * scale), h: even(size.h * scale) };
    if (await check(codec, smallest)) return smallest;
  }
  return smallest;
}
