import * as S from "@effect/schema/Schema";
import * as Effect from "effect/Effect";

import type {
  ACL,
  FetchContextService,
  FetchEsque,
  MaybeUrl,
  SerializedUploadThingError,
} from "@uploadthing/shared";
import {
  asArray,
  FetchContext,
  fetchEff,
  generateUploadThingURL,
  parseResponseJson,
  UploadThingError,
} from "@uploadthing/shared";

import { UPLOADTHING_VERSION } from "../internal/constants";
import { getApiKeyOrThrow } from "../internal/get-api-key";
import { incompatibleNodeGuard } from "../internal/incompat-node-guard";
import type { LogLevel } from "../internal/logger";
import { ConsolaLogger, withMinimalLogLevel } from "../internal/logger";
import type {
  ACLUpdateOptions,
  DeleteFilesOptions,
  FileEsque,
  GetFileUrlsOptions,
  GetSignedURLOptions,
  ListFilesOptions,
  RenameFileUpdate,
  UploadFileResult,
  UploadFilesOptions,
  UrlWithOverrides,
  UTApiOptions,
} from "./types";
import { UTFile } from "./ut-file";
import {
  downloadFiles,
  guardServerOnly,
  parseTimeToSeconds,
  uploadFilesInternal,
} from "./utils";

export { UTFile };

export class UTApi {
  private fetch: FetchEsque;
  private defaultHeaders: FetchContextService["baseHeaders"];
  private defaultKeyType: "fileKey" | "customId";
  private logLevel: LogLevel | undefined;
  constructor(opts?: UTApiOptions) {
    // Assert some stuff
    guardServerOnly();
    incompatibleNodeGuard();
    const apiKey = getApiKeyOrThrow(opts?.apiKey);

    this.fetch = opts?.fetch ?? globalThis.fetch;
    this.defaultHeaders = {
      "x-uploadthing-api-key": apiKey,
      "x-uploadthing-version": UPLOADTHING_VERSION,
      "x-uploadthing-be-adapter": "server-sdk",
      "x-uploadthing-fe-package": undefined,
    };
    this.defaultKeyType = opts?.defaultKeyType ?? "fileKey";
    this.logLevel = opts?.logLevel;
  }

  private requestUploadThing = <T>(
    pathname: `/${string}`,
    body: Record<string, unknown>,
    responseSchema: S.Schema<T, any>,
  ) => {
    const url = generateUploadThingURL(pathname);
    Effect.runSync(
      Effect.logDebug("Requesting UploadThing:", {
        url,
        body,
        headers: this.defaultHeaders,
      }),
    );

    const headers = new Headers([["Content-Type", "application/json"]]);
    for (const [key, value] of Object.entries(this.defaultHeaders)) {
      if (typeof value === "string") headers.set(key, value);
    }

    return fetchEff(url, {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
      headers,
    }).pipe(
      Effect.andThen(parseResponseJson),
      Effect.andThen(S.decodeUnknown(responseSchema)),
      Effect.catchTag("FetchError", (err) =>
        Effect.logError("Request failed:", err).pipe(
          Effect.andThen(() => Effect.die(err)),
        ),
      ),
      Effect.catchTag("ParseError", (err) =>
        Effect.logError("Response parsing failed:", err).pipe(
          Effect.andThen(() => Effect.die(err)),
        ),
      ),
      Effect.tap((res) => Effect.logDebug("UploadThing response:", res)),
    );
  };

  private executeAsync = <A, E>(
    program: Effect.Effect<A, E, FetchContext>,
    signal?: AbortSignal,
  ) =>
    program.pipe(
      withMinimalLogLevel(this.logLevel),
      Effect.provide(ConsolaLogger),
      Effect.provideService(FetchContext, {
        fetch: this.fetch,
        baseHeaders: this.defaultHeaders,
      }),
      (e) => Effect.runPromise(e, signal ? { signal } : undefined),
    );

  /**
   * Upload files to UploadThing storage.
   *
   * @example
   * await uploadFiles(new File(["foo"], "foo.txt"));
   *
   * @example
   * await uploadFiles([
   *   new File(["foo"], "foo.txt"),
   *   new File(["bar"], "bar.txt"),
   * ]);
   */
  uploadFiles(
    files: FileEsque,
    opts?: UploadFilesOptions,
  ): Promise<UploadFileResult>;
  uploadFiles(
    files: FileEsque[],
    opts?: UploadFilesOptions,
  ): Promise<UploadFileResult[]>;
  async uploadFiles(
    files: FileEsque | FileEsque[],
    opts?: UploadFilesOptions,
  ): Promise<UploadFileResult | UploadFileResult[]> {
    guardServerOnly();

    const uploads = await this.executeAsync(
      Effect.flatMap(
        uploadFilesInternal({
          files: asArray(files),
          contentDisposition: opts?.contentDisposition ?? "inline",
          metadata: opts?.metadata ?? {},
          acl: opts?.acl,
        }),
        (ups) => Effect.succeed(Array.isArray(files) ? ups : ups[0]),
      ).pipe(Effect.tap((res) => Effect.logDebug("Finished uploading:", res))),
      opts?.signal,
    );
    return uploads;
  }

  /**
   * @param {string} url The URL of the file to upload
   * @param {Json} metadata JSON-parseable metadata to attach to the uploaded file(s)
   *
   * @example
   * await uploadFileFromUrl("https://uploadthing.com/f/2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg");
   *
   * @example
   * await uploadFileFromUrl([
   *   "https://uploadthing.com/f/2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg",
   *   "https://uploadthing.com/f/1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg"
   * ])
   */
  uploadFilesFromUrl(
    urls: MaybeUrl | UrlWithOverrides,
    opts?: UploadFilesOptions,
  ): Promise<UploadFileResult>;
  uploadFilesFromUrl(
    urls: (MaybeUrl | UrlWithOverrides)[],
    opts?: UploadFilesOptions,
  ): Promise<UploadFileResult[]>;
  async uploadFilesFromUrl(
    urls: MaybeUrl | UrlWithOverrides | (MaybeUrl | UrlWithOverrides)[],
    opts?: UploadFilesOptions,
  ): Promise<UploadFileResult | UploadFileResult[]> {
    guardServerOnly();

    const downloadErrors: Record<number, SerializedUploadThingError> = {};

    const uploads = await this.executeAsync(
      downloadFiles(asArray(urls), downloadErrors).pipe(
        Effect.andThen((files) => files.filter((f): f is UTFile => f != null)),
        Effect.andThen((files) =>
          uploadFilesInternal({
            files,
            contentDisposition: opts?.contentDisposition ?? "inline",
            metadata: opts?.metadata ?? {},
            acl: opts?.acl,
          }),
        ),
      ),
      opts?.signal,
    );

    /** Put it all back together, preserve the order of files */
    const responses = asArray(urls).map((_, index) => {
      if (downloadErrors[index]) {
        return { data: null, error: downloadErrors[index] };
      }
      return uploads.shift()!;
    });

    /** Return single object or array based on input urls */
    const uploadFileResponse = Array.isArray(urls) ? responses : responses[0];

    Effect.runSync(Effect.logDebug("Finished uploading:", uploadFileResponse));
    return uploadFileResponse;
  }

  /**
   * Request to delete files from UploadThing storage.
   * @param {string | string[]} fileKeys
   *
   * @example
   * await deleteFiles("2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg");
   *
   * @example
   * await deleteFiles(["2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg","1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg"])
   *
   * @example
   * await deleteFiles("myCustomIdentifier", { keyType: "customId" })
   */
  deleteFiles = async (keys: string[] | string, opts?: DeleteFilesOptions) => {
    guardServerOnly();
    const { keyType = this.defaultKeyType } = opts ?? {};

    class DeleteFileResponse extends S.Class<DeleteFileResponse>(
      "DeleteFileResponse",
    )({
      success: S.Boolean,
      deletedCount: S.Number,
    }) {}

    return await this.executeAsync(
      this.requestUploadThing(
        "/api/deleteFiles",
        keyType === "fileKey"
          ? { fileKeys: asArray(keys) }
          : { customIds: asArray(keys) },
        DeleteFileResponse,
      ),
    );
  };

  /**
   * Request file URLs from UploadThing storage.
   * @param {string | string[]} fileKeys
   *
   * @example
   * const data = await getFileUrls("2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg");
   * console.log(data); // [{key: "2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg", url: "https://uploadthing.com/f/2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg"}]
   *
   * @example
   * const data = await getFileUrls(["2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg","1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg"])
   * console.log(data) // [{key: "2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg", url: "https://uploadthing.com/f/2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg" },{key: "1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg", url: "https://uploadthing.com/f/1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg"}]
   */
  getFileUrls = async (keys: string[] | string, opts?: GetFileUrlsOptions) => {
    guardServerOnly();

    const { keyType = this.defaultKeyType } = opts ?? {};

    class GetFileUrlResponse extends S.Class<GetFileUrlResponse>(
      "GetFileUrlResponse",
    )({
      data: S.Array(
        S.Struct({
          key: S.String,
          url: S.String,
        }),
      ),
    }) {}

    return await this.executeAsync(
      this.requestUploadThing(
        "/api/getFileUrl",
        keyType === "fileKey" ? { fileKeys: keys } : { customIds: keys },
        GetFileUrlResponse,
      ),
    );
  };

  /**
   * Request file list from UploadThing storage.
   * @param {object} opts
   * @param {number} opts.limit The maximum number of files to return
   * @param {number} opts.offset The number of files to skip
   *
   * @example
   * const data = await listFiles({ limit: 1 });
   * console.log(data); // { key: "2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg", id: "2e0fdb64-9957-4262-8e45-f372ba903ac8" }
   */
  listFiles = async (opts?: ListFilesOptions) => {
    guardServerOnly();

    class ListFileResponse extends S.Class<ListFileResponse>(
      "ListFileResponse",
    )({
      hasMore: S.Boolean,
      files: S.Array(
        S.Struct({
          id: S.String,
          customId: S.NullOr(S.String),
          key: S.String,
          name: S.String,
          status: S.Literal(
            "Deletion Pending",
            "Failed",
            "Uploaded",
            "Uploading",
          ),
        }),
      ),
    }) {}

    return await this.executeAsync(
      this.requestUploadThing("/api/listFiles", { ...opts }, ListFileResponse),
    );
  };

  renameFiles = async (updates: RenameFileUpdate | RenameFileUpdate[]) => {
    guardServerOnly();

    class RenameFileResponse extends S.Class<RenameFileResponse>(
      "RenameFileResponse",
    )({
      success: S.Boolean,
    }) {}

    return await this.executeAsync(
      this.requestUploadThing(
        "/api/renameFiles",
        { updates: asArray(updates) },
        RenameFileResponse,
      ),
    );
  };

  /** @deprecated Use {@link renameFiles} instead. */
  public renameFile = this.renameFiles;

  getUsageInfo = async () => {
    guardServerOnly();

    class GetUsageInfoResponse extends S.Class<GetUsageInfoResponse>(
      "GetUsageInfoResponse",
    )({
      totalBytes: S.Number,
      appTotalBytes: S.Number,
      filesUploaded: S.Number,
      limitBytes: S.Number,
    }) {}

    return await this.executeAsync(
      this.requestUploadThing("/api/getUsageInfo", {}, GetUsageInfoResponse),
    );
  };

  /** Request a presigned url for a private file(s) */
  getSignedURL = async (key: string, opts?: GetSignedURLOptions) => {
    guardServerOnly();

    const expiresIn = opts?.expiresIn
      ? parseTimeToSeconds(opts.expiresIn)
      : undefined;
    const { keyType = this.defaultKeyType } = opts ?? {};

    if (opts?.expiresIn && isNaN(expiresIn!)) {
      throw new UploadThingError({
        code: "BAD_REQUEST",
        message:
          "expiresIn must be a valid time string, for example '1d', '2 days', or a number of seconds.",
      });
    }
    if (expiresIn && expiresIn > 86400 * 7) {
      throw new UploadThingError({
        code: "BAD_REQUEST",
        message: "expiresIn must be less than 7 days (604800 seconds).",
      });
    }

    class GetSignedUrlResponse extends S.Class<GetSignedUrlResponse>(
      "GetSignedUrlResponse",
    )({
      url: S.String,
    }) {}

    return await this.executeAsync(
      this.requestUploadThing(
        "/api/requestFileAccess",
        keyType === "fileKey"
          ? { fileKey: key, expiresIn }
          : { customId: key, expiresIn },
        GetSignedUrlResponse,
      ),
    );
  };

  /**
   * Update the ACL of a file or set of files.
   *
   * @example
   * // Make a single file public
   * await utapi.updateACL("2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg", "public-read");
   *
   * // Make multiple files private
   * await utapi.updateACL(
   *   [
   *     "2e0fdb64-9957-4262-8e45-f372ba903ac8_image.jpg",
   *     "1649353b-04ea-48a2-9db7-31de7f562c8d_image2.jpg",
   *   ],
   *   "private",
   * );
   */
  updateACL = async (
    keys: string | string[],
    acl: ACL,
    opts?: ACLUpdateOptions,
  ) => {
    guardServerOnly();

    const { keyType = this.defaultKeyType } = opts ?? {};
    const updates = asArray(keys).map((key) => {
      return keyType === "fileKey"
        ? { fileKey: key, acl }
        : { customId: key, acl };
    });

    const responseSchema = S.Struct({
      success: S.Boolean,
    });

    return await this.executeAsync(
      this.requestUploadThing("/api/updateACL", { updates }, responseSchema),
    );
  };
}
