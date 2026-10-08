import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { contentTypeFor } from "./mime.js";
import type { UploadSource } from "./types.js";

/**
 * Reads a file from disk as a streamed upload source. The bytes are streamed
 * when the upload starts, so multi-gigabyte files never sit in memory.
 *
 * ```ts
 * import { fileFromPath } from "@steadylink/sdk/node";
 * await steadylink.upload(bucketId, await fileFromPath("./video.mp4"));
 * ```
 */
export async function fileFromPath(path: string, options: { filename?: string; contentType?: string; path?: string } = {}): Promise<UploadSource> {
  const info = await stat(path);
  if (!info.isFile()) throw new TypeError(`${path} is not a file`);
  const filename = options.filename ?? basename(path);
  const source: UploadSource = {
    filename,
    size: info.size,
    contentType: options.contentType ?? contentTypeFor(filename),
    // Created lazily so an unused source never holds a file descriptor open.
    get data() { return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array> },
  };
  if (options.path) source.path = options.path;
  return source;
}
