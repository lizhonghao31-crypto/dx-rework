export const SUPPORTED_ATTACHMENT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_IMAGE_EDGE = 2048;
const WEBP_QUALITY = 0.85;

type NetworkInformationLike = Readonly<{ effectiveType?: string }>;

/**
 * A third lane eliminates the second upload wave for ordinary 3–5-photo QC
 * batches. Deliberately retain backpressure for slow mobile networks.
 */
export const qcUploadConcurrency = (connection?: NetworkInformationLike): number => {
  switch (connection?.effectiveType) {
    case "slow-2g":
    case "2g":
      return 1;
    case "3g":
      return 2;
    default:
      return 3;
  }
};

export const currentQcUploadConcurrency = (): number => {
  if (typeof navigator === "undefined") return 3;
  return qcUploadConcurrency((navigator as Navigator & { connection?: NetworkInformationLike }).connection);
};

export const isSupportedAttachment = (file: Pick<File, "type">): boolean =>
  SUPPORTED_ATTACHMENT_MIME_TYPES.has(file.type);

export const isImageAttachment = (file: Pick<File, "type">): boolean =>
  IMAGE_MIME_TYPES.has(file.type);

export const sha256Hex = async (file: Blob): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const webpFilename = (filename: string): string => {
  const stem = filename.replace(/\.[^.]+$/, "").trim() || "evidence";
  return `${stem}.webp`;
};

const canvasBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, "image/webp", WEBP_QUALITY));

/**
 * QC photos are reduced before hashing/uploading. This preserves the original
 * whenever the browser cannot safely encode WebP or no material byte saving is
 * achieved, so evidence clarity never regresses merely for conversion's sake.
 */
export const prepareAttachmentForUpload = async (file: File): Promise<File> => {
  if (!isImageAttachment(file) || typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const longestEdge = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, MAX_IMAGE_EDGE / longestEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);

    const compressed = await canvasBlob(canvas);
    if (!compressed || compressed.type !== "image/webp" || compressed.size >= file.size * 0.95) {
      return file;
    }
    return new File([compressed], webpFilename(file.name), {
      type: "image/webp",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
};

/**
 * Keeps the existing two-way preparation capacity while starting each upload
 * as soon as its own preparation finishes. Uploads are independently capped,
 * so lower-performance phones and weaker networks are not saturated.
 */
export const prepareAndUploadWithConcurrency = async <T, Prepared, Result>(
  items: readonly T[],
  limit: number,
  prepare: (item: T, index: number) => Promise<Prepared>,
  upload: (prepared: Prepared, item: T, index: number) => Promise<Result>,
): Promise<Result[]> => {
  const results = new Array<Result>(items.length);
  const concurrency = Math.max(1, Math.min(Math.max(1, limit), items.length));
  const inFlight = new Set<Promise<void>>();
  let nextIndex = 0;
  let stopped = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index]!;
      const prepared = await prepare(item, index);
      if (firstError !== undefined) throw firstError;
      while (!stopped && inFlight.size >= concurrency) {
        await Promise.race(inFlight);
      }
      if (stopped || firstError !== undefined) {
        if (firstError !== undefined) throw firstError;
        return;
      }

      const task = upload(prepared, item, index).then((result) => {
        results[index] = result;
      });
      inFlight.add(task);
      task.then(
        () => inFlight.delete(task),
        (error: unknown) => {
          if (firstError === undefined) firstError = error;
          stopped = true;
          inFlight.delete(task);
        },
      );
    }
  };

  const workers = Array.from({ length: concurrency }, worker);
  try {
    await Promise.all(workers);
    if (firstError !== undefined) throw firstError;
    await Promise.all(inFlight);
    if (firstError !== undefined) throw firstError;
  } catch (error) {
    stopped = true;
    await Promise.allSettled(workers);
    await Promise.allSettled(inFlight);
    throw error;
  }

  return results;
};
