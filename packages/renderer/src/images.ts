// SPDX-License-Identifier: GPL-3.0-or-later

// Image levels of detail. Every image comes in stored versions (reduced-size
// copies made when the image was added, and the original), smallest first. The
// renderer decodes the smallest version that is at least as large as the image
// is on screen, and draws the nearest decoded version until it arrives. The
// original is decoded only when no reduced version is large enough, so loading a
// document never decodes originals (docs/adr/0004, "Image levels of detail").
//
// Decoding, by what the browser has:
// - WebCodecs ImageDecoder (Chromium, Firefox): off the main thread, and able to
//   decode an original at reduced size (Chromium picks 1/2, 1/4 or 1/8, Firefox
//   the exact size), so a large original is never decoded at full size unless it
//   is that large on screen;
// - otherwise createImageBitmap in a worker (WebKit), so decoding never blocks
//   the main thread;
// - otherwise createImageBitmap on the main thread.
//
// Decoded versions beyond a byte budget are closed, least recently drawn first;
// the smallest version of each image is kept.

/** Pixel size of a stored version of an image. */
export interface ImageLevel {
  readonly width: number;
  readonly height: number;
}

/** Where the renderer gets image bytes. */
export interface ImageSource {
  /**
   * The stored versions of an image asset, smallest first; the last is the
   * original. Undefined if the asset is unknown or has no bytes (missing).
   */
  levels(asset: string): readonly ImageLevel[] | undefined;
  /** The encoded file of one stored version (an index into levels()). */
  blob(asset: string, level: number): Blob | Promise<Blob>;
}

/** A decoded image the canvas can draw. */
export interface Decoded {
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** Decodes an encoded file, at (width, height) if it can decode at reduced size. */
export type DecodeFn = (blob: Blob, width: number, height: number) => Promise<Decoded>;

export type DecoderKind = "imagedecoder" | "worker" | "main";

/** The decoder this browser supports best. */
export function defaultDecoderKind(): DecoderKind {
  if (typeof ImageDecoder === "function") return "imagedecoder";
  if (typeof Worker === "function" && typeof URL.createObjectURL === "function")
    return "worker";
  return "main";
}

function fromBitmap(bitmap: ImageBitmap): Decoded {
  return {
    image: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    close: () => bitmap.close(),
  };
}

/** WebCodecs: decodes at reduced size where the format allows it. */
export async function decodeWithImageDecoder(
  blob: Blob,
  width: number,
  height: number,
): Promise<Decoded> {
  const decoder = new ImageDecoder({
    data: blob.stream(),
    type: blob.type || "image/jpeg",
    desiredWidth: width,
    desiredHeight: height,
  });
  try {
    const { image } = await decoder.decode();
    try {
      const bitmap =
        image.displayWidth === width && image.displayHeight === height
          ? await createImageBitmap(image)
          : await createImageBitmap(image, {
              resizeWidth: width,
              resizeHeight: height,
              resizeQuality: "medium",
            });
      return fromBitmap(bitmap);
    } finally {
      image.close();
    }
  } finally {
    decoder.close();
  }
}

/** createImageBitmap on the main thread (the browser may still decode elsewhere). */
export async function decodeOnMainThread(blob: Blob): Promise<Decoded> {
  return fromBitmap(await createImageBitmap(blob));
}

const WORKER_SOURCE = `
self.onmessage = async (event) => {
  const { id, blob } = event.data;
  try {
    const bitmap = await createImageBitmap(blob);
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
`;

/** A worker that has not answered at all after this long is taken as broken. */
export const WORKER_START_TIMEOUT_MS = 5000;
/** One decode in a working worker may take this long before it is redone elsewhere. */
export const WORKER_DECODE_TIMEOUT_MS = 60000;

/** The parts of the Worker API the decoder uses (tests pass a stand-in). */
export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface WorkerDecoderOptions {
  /** Makes the worker; by default a dedicated worker from a string. */
  readonly create?: () => WorkerLike;
  /** Where decodes go when the worker cannot be used. Default the main thread. */
  readonly fallback?: DecodeFn;
  readonly startTimeoutMs?: number;
  readonly decodeTimeoutMs?: number;
}

/**
 * A decoder that runs createImageBitmap in a dedicated worker. The worker is
 * made from a string, so it needs no separate file in any build. If the worker
 * cannot be made, reports an error, or does not answer at all within
 * startTimeoutMs (a content security policy that forbids blob: workers, for
 * example), every waiting and later decode goes to the fallback instead; a
 * single decode that takes longer than decodeTimeoutMs is redone there too.
 */
export function workerDecoder(options: WorkerDecoderOptions = {}): {
  decode: DecodeFn;
  dispose(): void;
  readonly broken: boolean;
} {
  const fallback: DecodeFn = options.fallback ?? ((blob) => decodeOnMainThread(blob));
  const startTimeout = options.startTimeoutMs ?? WORKER_START_TIMEOUT_MS;
  const decodeTimeout = options.decodeTimeoutMs ?? WORKER_DECODE_TIMEOUT_MS;
  let worker: WorkerLike | null = null;
  let url = "";
  let next = 0;
  let broken = false;
  let answered = false;
  interface Waiting {
    readonly blob: Blob;
    readonly width: number;
    readonly height: number;
    readonly resolve: (d: Decoded) => void;
    readonly reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
  }
  const waiting = new Map<number, Waiting>();
  const elsewhere = (entry: Waiting): void => {
    clearTimeout(entry.timer);
    fallback(entry.blob, entry.width, entry.height).then(entry.resolve, entry.reject);
  };
  const giveUp = (): void => {
    broken = true;
    worker?.terminate();
    worker = null;
    const list = [...waiting.values()];
    waiting.clear();
    for (const entry of list) elsewhere(entry);
  };
  const start = (): WorkerLike | null => {
    if (worker || broken) return worker;
    try {
      if (options.create) worker = options.create();
      else {
        url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
        worker = new Worker(url) as unknown as WorkerLike;
      }
    } catch {
      giveUp();
      return null;
    }
    worker.onerror = () => giveUp();
    worker.onmessage = (event: MessageEvent) => {
      answered = true;
      const { id, bitmap, error } = event.data as {
        id: number;
        bitmap?: ImageBitmap;
        error?: string;
      };
      const entry = waiting.get(id);
      waiting.delete(id);
      if (!entry) {
        bitmap?.close();
        return;
      }
      clearTimeout(entry.timer);
      if (bitmap) entry.resolve(fromBitmap(bitmap));
      else entry.reject(new Error(error ?? "decode failed"));
    };
    return worker;
  };
  return {
    get broken() {
      return broken;
    },
    decode(blob, width, height) {
      if (broken) return fallback(blob, width, height);
      const id = next++;
      return new Promise<Decoded>((resolve, reject) => {
        const entry: Waiting = { blob, width, height, resolve, reject, timer: undefined };
        waiting.set(id, entry);
        const w = start();
        if (!w) return; // giveUp() has sent it elsewhere
        entry.timer = setTimeout(
          () => {
            if (!waiting.has(id)) return;
            if (!answered) giveUp();
            else {
              waiting.delete(id);
              elsewhere(entry);
            }
          },
          answered ? decodeTimeout : startTimeout,
        );
        w.postMessage({ id, blob });
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      if (url) URL.revokeObjectURL(url);
      for (const entry of waiting.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("disposed"));
      }
      waiting.clear();
    },
  };
}

/** A version the cache can decode: a stored level, at its own or a reduced size. */
export interface Version {
  /** Index of the stored level that is decoded. */
  readonly level: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The versions of an image the cache can produce, smallest first. With a decoder
 * that decodes at reduced size, the original also offers halves, quarters and so
 * on that are larger than the largest reduced level.
 */
export function versionsOf(
  levels: readonly ImageLevel[],
  reducedDecode: boolean,
): Version[] {
  const out: Version[] = levels.map((l, level) => ({
    level,
    width: l.width,
    height: l.height,
  }));
  if (!reducedDecode || levels.length === 0) return out;
  const original = levels.length - 1;
  const { width, height } = levels[original]!;
  const largestReduced = original > 0 ? levels[original - 1]!.width : 0;
  const extra: Version[] = [];
  for (let f = 2; width / f > largestReduced && width / f >= 1; f *= 2) {
    extra.push({
      level: original,
      width: Math.max(1, Math.round(width / f)),
      height: Math.max(1, Math.round(height / f)),
    });
  }
  extra.reverse();
  out.splice(original, 0, ...extra);
  return out;
}

/**
 * Index of the version to use for an image drawn `pixels` device pixels wide:
 * the smallest that is at least that wide, else the largest.
 */
export function pickVersion(versions: readonly Version[], pixels: number): number {
  for (let i = 0; i < versions.length; i++) {
    if (versions[i]!.width >= pixels) return i;
  }
  return versions.length - 1;
}

interface Slot {
  decoded: Decoded | null;
  pending: boolean;
  /** The last decode failed; tried again from retryAt on. */
  failed: boolean;
  retryAt: number;
  retryDelay: number;
  lastUsed: number;
  bytes: number;
}

/** An asset the source did not have; asked again from retryAt on. */
interface Missing {
  readonly missing: true;
  readonly retryAt: number;
  readonly retryDelay: number;
}

/** First wait before asking again for a missing image or a failed decode. */
export const RETRY_FIRST_MS = 1000;
/** Longest wait between tries; the wait doubles up to this. */
export const RETRY_MAX_MS = 60000;

interface Entry {
  readonly asset: string;
  readonly versions: readonly Version[];
  readonly slots: Slot[];
}

/** What drawImage gets back from the cache. */
export type Pick =
  | { readonly state: "drawn"; readonly decoded: Decoded; readonly exact: boolean }
  | { readonly state: "loading" | "missing" };

export interface ImageCacheOptions {
  readonly decoder?: DecoderKind;
  /** A decode function of one's own (tests); overrides `decoder`. */
  readonly decode?: DecodeFn;
  /** Whether `decode` decodes at reduced size. */
  readonly reducedDecode?: boolean;
  /** Bytes of decoded pixels kept, besides the smallest version of each image. */
  readonly budgetBytes?: number;
  /** Decodes running at once. */
  readonly maxInFlight?: number;
  /** Called when a decode finished, so the host can draw again. */
  readonly onChange?: () => void;
  /** Clock for the retry waits, in milliseconds (tests). Default performance.now. */
  readonly now?: () => number;
}

export interface ImageCacheStats {
  decodes: number;
  failures: number;
  evictions: number;
  decodedBytes: number;
  peakDecodedBytes: number;
  /** Decodes of an original at full size. */
  originalDecodes: number;
}

export class ImageCache {
  readonly #source: ImageSource;
  readonly #decode: DecodeFn;
  readonly #reduced: boolean;
  readonly #budget: number;
  readonly #maxInFlight: number;
  readonly #onChange: (() => void) | undefined;
  readonly #dispose: (() => void) | undefined;
  readonly #entries = new Map<string, Entry | Missing>();
  readonly #now: () => number;
  readonly #wants = new Map<
    Slot,
    { entry: Entry; index: number; frame: number; pixels: number }
  >();
  #frame = 0;
  #inFlight = 0;
  #bytes = 0;
  #disposed = false;
  readonly stats: ImageCacheStats = {
    decodes: 0,
    failures: 0,
    evictions: 0,
    decodedBytes: 0,
    peakDecodedBytes: 0,
    originalDecodes: 0,
  };
  readonly decoderKind: DecoderKind | "custom";

  constructor(source: ImageSource, options: ImageCacheOptions = {}) {
    this.#source = source;
    this.#budget = options.budgetBytes ?? 384 * 2 ** 20;
    this.#maxInFlight = options.maxInFlight ?? 3;
    this.#onChange = options.onChange;
    this.#now = options.now ?? (() => performance.now());
    if (options.decode) {
      this.#decode = options.decode;
      this.#reduced = options.reducedDecode ?? false;
      this.decoderKind = "custom";
      this.#dispose = undefined;
    } else {
      const kind = options.decoder ?? defaultDecoderKind();
      this.decoderKind = kind;
      if (kind === "imagedecoder") {
        this.#decode = decodeWithImageDecoder;
        this.#reduced = true;
        this.#dispose = undefined;
      } else if (kind === "worker") {
        const worker = workerDecoder();
        this.#decode = worker.decode;
        this.#reduced = false;
        this.#dispose = () => worker.dispose();
      } else {
        this.#decode = (blob) => decodeOnMainThread(blob);
        this.#reduced = false;
        this.#dispose = undefined;
      }
    }
  }

  #entry(asset: string): Entry | null {
    const known = this.#entries.get(asset);
    if (known && !("missing" in known)) return known;
    const now = this.#now();
    if (known && now < known.retryAt) return null;
    const levels = this.#source.levels(asset);
    if (!levels || levels.length === 0) {
      // Not there (yet): ask again later, waiting longer each time. forget()
      // asks again at once.
      const delay = known ? Math.min(known.retryDelay * 2, RETRY_MAX_MS) : RETRY_FIRST_MS;
      this.#entries.set(asset, {
        missing: true,
        retryAt: now + delay,
        retryDelay: delay,
      });
      return null;
    }
    const versions = versionsOf(levels, this.#reduced);
    const entry: Entry = {
      asset,
      versions,
      slots: versions.map(() => ({
        decoded: null,
        pending: false,
        failed: false,
        retryAt: 0,
        retryDelay: 0,
        lastUsed: -1,
        bytes: 0,
      })),
    };
    this.#entries.set(asset, entry);
    return entry;
  }

  /** True if the slot may be decoded now (never failed, or its wait is over). */
  #mayTry(slot: Slot): boolean {
    return !slot.failed || this.#now() >= slot.retryAt;
  }

  /** Call at the start of each frame. */
  beginFrame(): void {
    this.#frame++;
  }

  /**
   * The best decoded version for an image drawn `pixels` device pixels wide (the
   * width of the whole image on screen, not of a crop), and a request for the
   * right one if it is missing.
   */
  pick(asset: string, pixels: number): Pick {
    const entry = this.#entry(asset);
    if (!entry) return { state: "missing" };
    const wanted = pickVersion(entry.versions, pixels);
    const slot = entry.slots[wanted]!;
    if (slot.decoded) {
      slot.lastUsed = this.#frame;
      return { state: "drawn", decoded: slot.decoded, exact: true };
    }
    if (this.#mayTry(slot)) this.#want(entry, wanted, pixels);
    // Nearest decoded version, preferring larger ones.
    for (let d = 1; d < entry.slots.length; d++) {
      for (const i of [wanted + d, wanted - d]) {
        const other = entry.slots[i];
        if (other?.decoded) {
          other.lastUsed = this.#frame;
          return { state: "drawn", decoded: other.decoded, exact: false };
        }
      }
    }
    if (entry.slots.every((s) => s.failed && !s.pending)) return { state: "missing" };
    return { state: "loading" };
  }

  #want(entry: Entry, index: number, pixels: number): void {
    const slot = entry.slots[index]!;
    if (slot.pending) return;
    const want = this.#wants.get(slot);
    if (want) {
      want.frame = this.#frame;
      want.pixels = pixels;
    } else this.#wants.set(slot, { entry, index, frame: this.#frame, pixels });
  }

  /** Call at the end of each frame: starts decodes for what this frame wanted. */
  endFrame(): void {
    // Versions that stood in for others while those loaded may now be idle.
    if (this.#bytes > this.#budget) this.#evict();
    for (const [slot, want] of this.#wants) {
      if (want.frame < this.#frame - 1) this.#wants.delete(slot);
    }
    while (this.#inFlight < this.#maxInFlight && this.#wants.size > 0) {
      let best: { slot: Slot; frame: number; pixels: number } | null = null;
      for (const [slot, want] of this.#wants) {
        if (
          !best ||
          want.frame > best.frame ||
          (want.frame === best.frame && want.pixels > best.pixels)
        )
          best = { slot, frame: want.frame, pixels: want.pixels };
      }
      if (!best) break;
      const want = this.#wants.get(best.slot)!;
      this.#wants.delete(best.slot);
      void this.#load(want.entry, want.index);
    }
  }

  /** True while decodes run or wait. */
  get busy(): boolean {
    return this.#inFlight > 0 || this.#wants.size > 0;
  }

  /** Decodes the smallest version of each asset (for a viewer that opens a document). */
  async preload(assets: Iterable<string>, concurrency = 4): Promise<void> {
    const queue: Entry[] = [];
    for (const asset of assets) {
      const entry = this.#entry(asset);
      if (entry) queue.push(entry);
    }
    const run = async (): Promise<void> => {
      for (let entry = queue.shift(); entry; entry = queue.shift())
        await this.#load(entry, 0);
    };
    await Promise.all(Array.from({ length: concurrency }, run));
  }

  /** Resolves when no decode is running or waiting. */
  async settle(): Promise<void> {
    while (this.busy && !this.#disposed) {
      this.endFrame();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async #load(entry: Entry, index: number): Promise<void> {
    const slot = entry.slots[index]!;
    if (slot.decoded || slot.pending || !this.#mayTry(slot)) return;
    const version = entry.versions[index]!;
    slot.pending = true;
    this.#inFlight++;
    // forget() may drop the entry while this runs; then the result is not kept.
    const current = (): boolean =>
      !this.#disposed && this.#entries.get(entry.asset) === entry;
    try {
      const blob = await this.#source.blob(entry.asset, version.level);
      if (!current()) return;
      const decoded = await this.#decode(blob, version.width, version.height);
      if (!current()) {
        decoded.close();
        return;
      }
      slot.failed = false;
      if (index === entry.versions.length - 1) this.stats.originalDecodes++;
      slot.decoded = decoded;
      slot.lastUsed = this.#frame;
      slot.bytes = decoded.width * decoded.height * 4;
      if (index !== 0) this.#bytes += slot.bytes;
      this.stats.decodes++;
      this.stats.decodedBytes += slot.bytes;
      this.stats.peakDecodedBytes = Math.max(
        this.stats.peakDecodedBytes,
        this.stats.decodedBytes,
      );
      this.#evict();
      this.#onChange?.();
    } catch {
      if (!current()) return;
      // Try again later, waiting longer each time.
      slot.retryDelay = slot.failed
        ? Math.min(slot.retryDelay * 2, RETRY_MAX_MS)
        : RETRY_FIRST_MS;
      slot.retryAt = this.#now() + slot.retryDelay;
      slot.failed = true;
      this.stats.failures++;
      this.#onChange?.();
    } finally {
      slot.pending = false;
      this.#inFlight--;
    }
  }

  #evict(): void {
    while (this.#bytes > this.#budget) {
      let victim: Slot | null = null;
      for (const entry of this.#entries.values()) {
        if ("missing" in entry) continue;
        for (let i = 1; i < entry.slots.length; i++) {
          const slot = entry.slots[i]!;
          if (!slot.decoded || slot.lastUsed >= this.#frame) continue;
          if (!victim || slot.lastUsed < victim.lastUsed) victim = slot;
        }
      }
      if (!victim) return;
      victim.decoded!.close();
      victim.decoded = null;
      this.#bytes -= victim.bytes;
      this.stats.decodedBytes -= victim.bytes;
      this.stats.evictions++;
    }
  }

  /**
   * Forgets everything about an asset: its decoded versions are closed, a
   * decode still running for it is dropped when it ends, and a record that it
   * was missing or failed is cleared, so the next frame asks the source again.
   * Call it when an asset's bytes arrive, change or go away (the renderer's
   * imagesChanged() does).
   */
  forget(asset: string): void {
    const entry = this.#entries.get(asset);
    if (entry && !("missing" in entry)) {
      for (let i = 0; i < entry.slots.length; i++) {
        const slot = entry.slots[i]!;
        if (slot.decoded) {
          slot.decoded.close();
          if (i !== 0) this.#bytes -= slot.bytes;
          this.stats.decodedBytes -= slot.bytes;
        }
        this.#wants.delete(slot);
      }
    }
    this.#entries.delete(asset);
  }

  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      if ("missing" in entry) continue;
      for (const slot of entry.slots) slot.decoded?.close();
    }
    this.#entries.clear();
    this.#wants.clear();
    this.#dispose?.();
  }
}
