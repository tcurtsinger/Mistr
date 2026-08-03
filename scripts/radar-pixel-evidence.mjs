export function isRadarSignalPixel(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);

  // The isolated MapLibre canvas is composited over Mistr's nonzero night
  // background (#050506), and WebView capture can lift that neutral black a
  // few levels. Require either meaningful color separation (including the
  // weakest translucent returns) or a clearly brighter pixel. This avoids
  // counting the stage itself as radar while retaining bright near-neutral
  // high-reflectivity colors.
  return maximum >= 24 || (maximum >= 8 && maximum - minimum >= 3);
}
