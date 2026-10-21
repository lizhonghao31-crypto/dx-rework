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
export const SMALL_IMAGE_DIRECT_UPLOAD_BYTES = 1024 * 1024;

type NetworkInformationLike = Readonly<{ effectiveType?: string }>;
export type AttachmentUploadStage = "prepare" | "hash" | "intent" | "oss" | "finalize";
export type AttachmentUploadTimingContext = Readonly<{
  diagnosticId: string;
  clientKind: "mobile" | "desktop";
  networkType: string;
  originalBytes: number;
  uploadBytes: number;
  mimeType: string;
}>;
export type AttachmentUploadTiming = AttachmentUploadTimingContext & Readonly<{
  stage: AttachmentUploadStage;
  status: "running" | "completed" | "failed";
  durationMs: number | null;
  recordedAt: string;
}>;

type UploadTimingGlobal = typeof globalThis & {
  __DX_REWORK_UPLOAD_TIMINGS__?: AttachmentUploadTiming[];
};

const timingGlobal = (): UploadTimingGlobal => globalThis as UploadTimingGlobal;
const uploadClock = (): number => globalThis.performance?.now() ?? Date.now();
const roundedMilliseconds = (value: number): number => Math.round(value * 10) / 10;

const storeUploadTiming = (timing: AttachmentUploadTiming): void => {
  const target = timingGlobal();
  const current = target.__DX_REWORK_UPLOAD_TIMINGS__ ?? [];
  const withoutCurrentStage = current.filter((entry) =>
    entry.diagnosticId !== timing.diagnosticId || entry.stage !== timing.stage);
  target.__DX_REWORK_UPLOAD_TIMINGS__ = [...withoutCurrentStage, timing].slice(-100);
};

export const currentUploadClientProfile = (): Pick<AttachmentUploadTimingContext, "clientKind" | "networkType"> => {
  if (typeof navigator === "undefined") return { clientKind: "desktop", networkType: "unknown" };
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return {
    clientKind: /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ? "mobile" : "desktop",
    networkType: connection?.effectiveType ?? "unknown",
  };
};

/**
 * Keeps a bounded, filename-free diagnostic buffer on globalThis. It is
 * intentionally invisible in the business UI and can be inspected from the
 * browser console as `window.__DX_REWORK_UPLOAD_TIMINGS__` during UAT.
 */
export const measureAttachmentUploadStage = async <T>(
  context: AttachmentUploadTimingContext,
  stage: AttachmentUploadStage,
  work: () => Promise<T>,
): Promise<T> => {
  const startedAt = uploadClock();
  storeUploadTiming({
    ...context,
    stage,
    status: "running",
    durationMs: null,
    recordedAt: new Date().toISOString(),
  });
  try {
    const result = await work();
    storeUploadTiming({
      ...context,
      stage,
      status: "completed",
      durationMs: roundedMilliseconds(uploadClock() - startedAt),
      recordedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    storeUploadTiming({
      ...context,
      stage,
      status: "failed",
      durationMs: roundedMilliseconds(uploadClock() - startedAt),
      recordedAt: new Date().toISOString(),
    });
    throw error;
  }
};

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

export const isImageUploadCandidate = (file: Pick<File, "type">): boolean =>
  file.type.startsWith("image/");

export const isReceivingImageCandidate = isImageUploadCandidate;

/**
 * Small camera images already transfer quickly, while decoding and re-encoding
 * them can take several seconds on lower-end phones. Keep compression for larger
 * images where the saved transfer time can repay that CPU cost.
 */
export const shouldCompressImageBeforeUpload = (
  file: Pick<File, "type" | "size">,
): boolean => isImageAttachment(file) && file.size > SMALL_IMAGE_DIRECT_UPLOAD_BYTES;

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

type DecodedReceivingImage = Readonly<{
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}>;

const loadReceivingImageElement = (file: File): Promise<DecodedReceivingImage> =>
  new Promise((resolve, reject) => {
    if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") {
      reject(new Error("当前浏览器无法读取这张图片"));
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    const release = () => URL.revokeObjectURL(objectUrl);
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        release();
        reject(new Error("图片内容无法识别"));
        return;
      }
      resolve({ source: image, width, height, close: release });
    };
    image.onerror = () => {
      release();
      reject(new Error("图片内容无法识别"));
    };
    image.src = objectUrl;
  });

const decodeReceivingImage = async (file: File): Promise<DecodedReceivingImage> => {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Some iOS/WeChat webviews can preview an image through <img> even when
      // createImageBitmap cannot decode it. Use that browser decoder as fallback.
    }
  }
  return loadReceivingImageElement(file);
};

/** Pattern-room production drawings must keep every pixel; never use the QC resize lane. */
export const normalizeOriginalImageForUpload = async (file: File, maxBytes = 20 * 1024 * 1024): Promise<File> => {
  const decoded = await decodeReceivingImage(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理这张图片");
    context.drawImage(decoded.source, 0, 0);
    const encode = (type: string, quality?: number) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));
    const result = (blob: Blob, extension: string) => new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "制作资料"}.${extension}`, { type: blob.type, lastModified: file.lastModified });
    // Prefer lossless PNG within both the upload cap and the server's PNG decode budget.
    if (decoded.height * (1 + decoded.width * 4) <= 128 * 1024 * 1024) {
      const png = await encode("image/png");
      if (png?.type === "image/png" && png.size > 0 && png.size <= maxBytes) return result(png, "png");
    }
    // Full dimensions are retained. Bound quality rather than silently downscaling drawings.
    for (const quality of [0.98, 0.95, 0.9, 0.85]) {
      const webp = await encode("image/webp", quality);
      if (webp?.type === "image/webp" && webp.size > 0 && webp.size <= maxBytes) return result(webp, "webp");
      if (webp?.type !== "image/webp") break;
    }
    // Browsers without WebP encoding still support full-size JPEG; flatten transparency to white.
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const quality of [0.98, 0.95, 0.9, 0.85]) {
      const jpeg = await encode("image/jpeg", quality);
      if (jpeg?.type === "image/jpeg" && jpeg.size > 0 && jpeg.size <= maxBytes) return result(jpeg, "jpg");
    }
    throw new Error(`图片保持原尺寸转换后仍超过 ${Math.floor(maxBytes / 1024 / 1024)} MB，请分成多张清晰图片上传`);
  } finally {
    decoded.close();
  }
};

const normalizedImageFilename = (filename: string, mimeType: string): string => {
  const stem = filename.replace(/\.[^.]+$/, "").trim() || "receiving-evidence";
  return `${stem}.${mimeType === "image/webp" ? "webp" : "jpg"}`;
};

export const normalizeReceivingImageForUpload = async (file: File): Promise<File> => {
  if (!isImageUploadCandidate(file)) throw new Error("请选择有效的图片文件");

  let decoded: DecodedReceivingImage | undefined;
  try {
    decoded = await decodeReceivingImage(file);
    const longestEdge = Math.max(decoded.width, decoded.height);
    const scale = Math.min(1, MAX_IMAGE_EDGE / longestEdge);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理这张图片");
    context.drawImage(decoded.source, 0, 0, width, height);

    const normalized = await canvasBlob(canvas);
    if (!normalized || normalized.type !== "image/webp") {
      throw new Error("当前浏览器无法转换这张图片");
    }
    return new File([normalized], normalizedImageFilename(file.name, normalized.type), {
      type: normalized.type,
      lastModified: file.lastModified,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("当前浏览器")) throw error;
    throw new Error("图片格式无法识别，请重新选择图片");
  } finally {
    decoded?.close();
  }
};

export const prepareImageUploadCandidate = async (file: File): Promise<File> =>
  isImageAttachment(file)
    ? prepareAttachmentForUpload(file)
    : normalizeReceivingImageForUpload(file);

export const INVALID_DECLARED_IMAGE_MESSAGE = "Uploaded object is not a valid file of the declared type";

export const INVALID_DECLARED_IMAGE_MESSAGE_ZH = "附件内容与申报文件类型不一致，请重新选择有效原文件";

export const hasInvalidDeclaredImageError = (error: unknown): boolean =>
  error instanceof Error && ([INVALID_DECLARED_IMAGE_MESSAGE, INVALID_DECLARED_IMAGE_MESSAGE_ZH].includes(error.message)
    || error.cause !== undefined && error.cause !== error && hasInvalidDeclaredImageError(error.cause));

/**
 * Retries an image whose declared MIME type does not match its real bytes after
 * decoding it in the browser and re-encoding it as validator-safe WebP. This is
 * shared by image upload entry points so WeChat-saved images behave the same as
 * camera photos without weakening server-side content validation.
 */
export const uploadImageWithNormalizationRetry = async <T>(
  source: File,
  prepared: File,
  uploadPrepared: (file: File) => Promise<T>,
): Promise<T> => {
  try {
    return await uploadPrepared(prepared);
  } catch (error) {
    if (!hasInvalidDeclaredImageError(error)) throw error;
  }

  try {
    return await uploadPrepared(await normalizeReceivingImageForUpload(source));
  } catch (error) {
    if (hasInvalidDeclaredImageError(error)) {
      throw new Error(`${source.name} 图片格式无法识别，请重新选择图片`);
    }
    throw error;
  }
};

/**
 * QC photos are reduced before hashing/uploading. This preserves the original
 * whenever the browser cannot safely encode WebP or no material byte saving is
 * achieved, so evidence clarity never regresses merely for conversion's sake.
 */
export const prepareAttachmentForUpload = async (file: File): Promise<File> => {
  if (!shouldCompressImageBeforeUpload(file) || typeof createImageBitmap !== "function") return file;

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
