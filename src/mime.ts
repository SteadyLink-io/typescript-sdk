const TYPES: Record<string, string> = {
  avif: "image/avif", bmp: "image/bmp", gif: "image/gif", heic: "image/heic", ico: "image/x-icon", jpeg: "image/jpeg", jpg: "image/jpeg",
  png: "image/png", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff", webp: "image/webp",
  aac: "audio/aac", flac: "audio/flac", m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
  m4v: "video/mp4", mov: "video/quicktime", mp4: "video/mp4", webm: "video/webm",
  csv: "text/csv", htm: "text/html", html: "text/html", md: "text/markdown", txt: "text/plain",
  css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", xml: "application/xml",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};

/** Guesses a MIME type from a filename extension. Falls back to `application/octet-stream`. */
export function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return TYPES[filename.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
