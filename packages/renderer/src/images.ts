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
  /**
   * The level can be decoded at any size, larger ones included: the original
   * of a vector image (SVG). Its width and height are its natural size.
   */
  readonly scalable?: boolean;
}

/** The longest side a scalable (vector) original is drawn at, in pixels. */
export const MAX_SCALABLE_SIDE = 4096;

/** The media type of SVG, which is decoded on the main thread through an image element. */
export const SVG_TYPE = "image/svg+xml";

/** Where the renderer gets image bytes. */
export interface ImageSource {
  /**
   * The stored versions of an image asset, smallest first; the last is the
   * original. Undefined if the asset is unknown or has no bytes (missing).
   */
  levels(asset: string): readonly ImageLevel[] | undefined;
  /** The encoded file of one stored version (an index into levels()). */
  blob(asset: string, level: number): Blob | Promise<Blob>;
  /**
   * A stored version could not be read or decoded. The renderer draws other
   * versions meanwhile; the source may make it again and then call
   * `imagesChanged`.
   */
  failed?(asset: string, level: number): void;
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

/** Pixels per unit of the absolute CSS lengths SVG sizes are given in. */
const CSS_UNITS: { readonly [unit: string]: number } = {
  "": 1,
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  pt: 96 / 72,
  pc: 16,
};

/**
 * An absolute SVG length in pixels, or undefined (percentages, em, missing).
 * The same conversion as the image extension's when it reads an SVG's natural
 * size (`svgLength` in @galatsa/extension-image); the two must agree.
 */
export function svgLength(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim().toLowerCase();
  let unitStart = text.length;
  while (unitStart > 0 && text[unitStart - 1]! >= "a" && text[unitStart - 1]! <= "z")
    unitStart--;
  if (unitStart > 0 && text[unitStart] === "e" && unitStart + 1 === text.length)
    return undefined;
  const number = text.slice(0, unitStart).trim();
  const factor = CSS_UNITS[text.slice(unitStart)];
  if (number === "" || factor === undefined || !/^[0-9.e+-]+$/.test(number))
    return undefined;
  const n = Number(number) * factor;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The size browsers give SVG without one of its own. */
const SVG_DEFAULT = { width: 300, height: 150 };

/** Elements that could make a canvas the SVG is drawn on unreadable, or pull in other content. */
const UNSAFE_SVG = new Set(["foreignobject", "script", "iframe", "object", "embed"]);

/** A raster image embedded in SVG may stay; anything else an `image` names is removed. */
const SAFE_HREF = /^data:image\/(?:png|jpeg|gif|webp);/i;

/**
 * An SVG file prepared to be drawn at a given size, or null if it is not SVG
 * the browser can parse. Its root gets that width and height, so the browser
 * draws the vector picture at that size rather than scaling a picture of its
 * natural size; an SVG without a viewBox gets one from its own width and
 * height, converted as its natural size was (300 by 150 where it gives none).
 * Content that could taint the canvas (`foreignObject`: HTML in the picture)
 * or pull in other documents (scripts, frames, images that are not embedded
 * PNG, JPEG, GIF or WebP, such as another SVG) is removed first.
 */
export function svgAtSize(text: string, width: number, height: number): string | null {
  if (typeof DOMParser !== "function" || typeof XMLSerializer !== "function") return null;
  const parsed = new DOMParser().parseFromString(text, SVG_TYPE);
  const root = parsed.documentElement;
  if (root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length > 0)
    return null;
  for (const element of [...parsed.getElementsByTagName("*")]) {
    const name = element.localName.toLowerCase();
    if (UNSAFE_SVG.has(name)) {
      element.remove();
      continue;
    }
    if (name === "image" || name === "feimage") {
      const href =
        element.getAttribute("href") ??
        element.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
        "";
      if (!SAFE_HREF.test(href.trim())) element.remove();
    }
  }
  if (!root.hasAttribute("viewBox")) {
    const w = svgLength(root.getAttribute("width")) ?? SVG_DEFAULT.width;
    const h = svgLength(root.getAttribute("height")) ?? SVG_DEFAULT.height;
    root.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  return new XMLSerializer().serializeToString(parsed);
}

/**
 * Decodes SVG at (width, height) through an image element, on the main thread.
 * An SVG image runs no scripts and loads nothing from outside.
 */
export async function decodeSvg(
  blob: Blob,
  width: number,
  height: number,
): Promise<Decoded> {
  const text = svgAtSize(await blob.text(), width, height);
  if (text === null) throw new Error("not SVG the browser can read");
  const url = URL.createObjectURL(new Blob([text], { type: SVG_TYPE }));
  try {
    const image = new Image(width, height);
    image.decoding = "async";
    image.src = url;
    await image.decode();
    // Drawn onto a canvas of the size asked for: browsers that cannot make a
    // bitmap of an SVG element directly can still draw it.
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d") as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error("no 2D context for SVG");
    ctx.drawImage(image, 0, 0, width, height);
    // Whatever slipped through: a picture that made its canvas unreadable is
    // not used, so it can never make the document's canvas unreadable too
    // (renderRegion, thumbnails and exports read their canvas).
    try {
      ctx.getImageData(0, 0, 1, 1);
    } catch {
      throw new Error("the SVG would make the canvas unreadable");
    }
    return fromBitmap(await createImageBitmap(canvas));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A canvas to draw into off screen: an OffscreenCanvas where there is one. */
export function makeCanvas(
  width: number,
  height: number,
): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
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
  if (levels.length === 0) return out;
  const original = levels.length - 1;
  const scalable = levels[original]!.scalable === true;
  if (scalable) {
    // A vector original is drawn at any size: also at twice, four times ... its
    // natural size, up to MAX_SCALABLE_SIDE, so it stays sharp when zoomed in.
    const { width, height } = levels[original]!;
    for (let f = 2; Math.max(width, height) * f <= MAX_SCALABLE_SIDE; f *= 2) {
      out.push({ level: original, width: width * f, height: height * f });
    }
  }
  if (!reducedDecode && !scalable) return out;
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
  /** Kept outside the byte budget: the smallest version, if it is small. */
  kept: boolean;
}

/**
 * The smallest version of an image is kept outside the byte budget only up to
 * this many pixels (512 by 512, 1 MB decoded): a larger smallest version (an
 * image without reduced versions, decoded whole where the decoder cannot
 * reduce) counts like any other and may be closed.
 */
export const KEPT_PIXELS = 512 * 512;

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
  /** Width of the stored original (the last level). */
  readonly originalWidth: number;
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
  /** How SVG is decoded (tests); default `decode` if given, else `decodeSvg`. */
  readonly decodeSvg?: DecodeFn;
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
  /**
   * Decodes of an original at any size (an original decoded at reduced size
   * included): what opening a document with stored reduced versions must not do.
   */
  originalLevelDecodes: number;
}

export class ImageCache {
  readonly #source: ImageSource;
  readonly #decode: DecodeFn;
  readonly #reduced: boolean;
  readonly #budget: number;
  readonly #maxInFlight: number;
  readonly #onChange: (() => void) | undefined;
  readonly #dispose: (() => void) | undefined;
  readonly #decodeSvg: DecodeFn;
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
    originalLevelDecodes: 0,
  };
  readonly decoderKind: DecoderKind | "custom";

  constructor(source: ImageSource, options: ImageCacheOptions = {}) {
    this.#source = source;
    this.#budget = options.budgetBytes ?? 384 * 2 ** 20;
    this.#maxInFlight = options.maxInFlight ?? 3;
    this.#onChange = options.onChange;
    this.#now = options.now ?? (() => performance.now());
    this.#decodeSvg = options.decodeSvg ?? options.decode ?? decodeSvg;
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
      originalWidth: levels[levels.length - 1]!.width,
      versions,
      slots: versions.map(() => ({
        decoded: null,
        pending: false,
        failed: false,
        retryAt: 0,
        retryDelay: 0,
        lastUsed: -1,
        bytes: 0,
        kept: false,
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
    let wanted = pickVersion(entry.versions, pixels);
    // A version that failed gives way to the nearest one that has not, larger
    // ones first, so a stored version that does not decode never leaves the
    // image loading (it is tried again only when all have failed).
    if (entry.slots[wanted]!.failed) {
      for (let d = 1; d < entry.slots.length; d++) {
        const larger = entry.slots[wanted + d];
        const smaller = entry.slots[wanted - d];
        if (larger !== undefined && !larger.failed) {
          wanted += d;
          break;
        }
        if (smaller !== undefined && !smaller.failed) {
          wanted -= d;
          break;
        }
      }
    }
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
      // SVG needs an image element, which neither ImageDecoder nor a worker has.
      const decoded =
        blob.type === SVG_TYPE
          ? await this.#decodeSvg(blob, version.width, version.height)
          : await this.#decode(blob, version.width, version.height);
      if (!current()) {
        decoded.close();
        return;
      }
      slot.failed = false;
      const original = entry.versions[entry.versions.length - 1]!.level;
      if (version.level === original) {
        this.stats.originalLevelDecodes++;
        if (version.width === entry.originalWidth) this.stats.originalDecodes++;
      }
      slot.decoded = decoded;
      slot.lastUsed = this.#frame;
      slot.bytes = decoded.width * decoded.height * 4;
      slot.kept = index === 0 && decoded.width * decoded.height <= KEPT_PIXELS;
      if (!slot.kept) this.#bytes += slot.bytes;
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
      try {
        this.#source.failed?.(entry.asset, version.level);
      } catch {
        // A source that throws here changes nothing for drawing.
      }
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
        for (let i = 0; i < entry.slots.length; i++) {
          const slot = entry.slots[i]!;
          if (slot.kept || !slot.decoded || slot.lastUsed >= this.#frame) continue;
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
          if (!slot.kept) this.#bytes -= slot.bytes;
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
