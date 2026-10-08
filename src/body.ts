/** Anything the SDK can upload. Streams must be paired with an explicit `size`. */
export type UploadData = Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string;
export type ByteProgress = (loaded: number, total: number) => void;

const CHUNK = 256 * 1024;

export const isNodeRuntime = (): boolean => {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return Boolean(proc?.versions?.node) && typeof (globalThis as { window?: unknown }).window === "undefined";
};

export function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(value) && typeof (value as ReadableStream).getReader === "function";
}

export function isBlob(value: unknown): value is Blob {
  return Boolean(value) && typeof (value as Blob).arrayBuffer === "function" && typeof (value as Blob).size === "number" && typeof (value as Blob).stream === "function";
}

/** Returns the byte length of in-memory data, or undefined for streams. */
export function byteLength(data: UploadData): number | undefined {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (isBlob(data)) return data.size;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return undefined;
}

function toBytes(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toStream(data: UploadData): ReadableStream<Uint8Array> {
  if (isReadableStream(data)) return data;
  if (isBlob(data)) return data.stream() as ReadableStream<Uint8Array>;
  const bytes = toBytes(data);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) { controller.close(); return }
      const end = Math.min(bytes.byteLength, offset + CHUNK);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

function counting(stream: ReadableStream<Uint8Array>, total: number, onProgress: ByteProgress): ReadableStream<Uint8Array> {
  let loaded = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      onProgress(loaded, total);
      controller.enqueue(chunk);
    },
  }));
}

export interface PreparedBody { body: BodyInit; streaming: boolean; total: number; reportsProgress: boolean }

/**
 * Chooses the request body. Streams (and, in Node, any body when progress is
 * requested) are sent as a counted stream with an explicit Content-Length so
 * large files never need to be buffered in memory.
 */
export function prepareBody(data: UploadData, size: number | undefined, onProgress?: ByteProgress): PreparedBody {
  const total = size ?? byteLength(data);
  if (total === undefined) throw new TypeError("size is required when uploading a stream");
  const stream = isReadableStream(data);
  if (onProgress && (stream || isNodeRuntime())) return { body: counting(toStream(data), total, onProgress), streaming: true, total, reportsProgress: true };
  if (stream) return { body: data, streaming: true, total, reportsProgress: false };
  const body = typeof data === "string" || isBlob(data) ? data : toBytes(data);
  return { body: body as BodyInit, streaming: false, total, reportsProgress: false };
}

/** Browser upload with real progress events. Only used when XMLHttpRequest exists. */
export function xhrPut(url: string, body: Blob | ArrayBuffer | ArrayBufferView | string, headers: Record<string, string>, onProgress: ByteProgress, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : event.loaded);
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(signal?.reason ?? new Error("Upload cancelled"));
    if (signal) {
      if (signal.aborted) { xhr.abort(); return }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(body as XMLHttpRequestBodyInit);
  });
}
