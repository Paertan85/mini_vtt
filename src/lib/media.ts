// Library media as the windows load it: through the map-media:// protocol,
// which the main process serves from the library folder by id.

/** The URL a map or handout is loaded from. */
export const mediaUrlOf = (id: string) => `map-media://${id}`;
