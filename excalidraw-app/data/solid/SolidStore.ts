// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * SolidStore — the pod-backed replacement for Excalidraw's `LocalData` storage
 * seam.
 *
 * THE CONTRACT. Excalidraw's example app persists a scene (elements + appState +
 * image files) to the browser via `LocalData` — a debounced KV save plus a load on
 * boot. This module backs that same save/load contract with the user's Solid pod:
 *
 *   - **One byte-exact `.excalidraw` scene resource per board** under a
 *     `…/drawings/` container, e.g. `…/drawings/<board>.excalidraw`. The body is the
 *     OPAQUE canvas JSON (`serializeAsJSON(elements, appState, files, "database")`),
 *     stored byte-for-byte — never shredded into triples. The editor reads it back
 *     and `restore()`s it exactly as it was written.
 *   - **Image blobs as SIBLING resources.** Excalidraw `BinaryFileData` carries a
 *     base64 `dataURL`; each file is written as its own `…/drawings/<board>.files/<id>`
 *     resource (the decoded image bytes), so the scene JSON stays small and the bytes
 *     live as real, individually-WAC-able pod resources. On load they are re-read and
 *     re-assembled into the `files` map the editor expects.
 *   - **A small `draw:Scene` RDF descriptor** (`<board>.ttl`) alongside the scene,
 *     built with `@jeswr/solid-drawing`'s `serializeScene` — title / created /
 *     modified / schemaVersion / viewBackgroundColor + `draw:sceneDocument` → the
 *     byte-exact `.excalidraw` resource. This is the ONLY RDF; the canvas is opaque.
 *     It lets the pod, the suite apps, and the federation FIND / TITLE / VERSION the
 *     drawing as Linked Data without parsing the canvas.
 *
 * OWNER-PRIVACY (fail-closed). The `…/drawings/` container is made owner-private once
 * up front via {@link establishContainerAcl} (owner-only `acl:accessTo` + `acl:default`)
 * BEFORE any body is written; if that cannot be established or POSITIVELY confirmed,
 * the store REFUSES to write. Per resource the BODY is written FIRST, then its own
 * owner-only `.acl` (which throws on any non-2xx except a documented 405). See `acl.ts`.
 *
 * AUTH. A `fetch` is injected (the auth seam) — the session installs a SCOPED authed
 * fetch (the reactive-auth manager's `fetch` accessor, or a DPoP-attaching fetch from a
 * restored credential); `globalThis.fetch` is never patched. The store takes an explicit
 * `fetch` so it is unit-testable without a server and works with any authed-fetch impl.
 *
 * RDF discipline: the descriptor is serialised by `@jeswr/solid-drawing` (n3.Writer
 * under the hood) and read back via `@jeswr/fetch-rdf`'s `parseSceneTtl`. No
 * hand-built triples.
 */

import { fetchRdf } from "@jeswr/fetch-rdf";
import { parseSceneTtl, serializeScene } from "@jeswr/solid-drawing";

import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import { establishContainerAcl, putResourceAcl } from "./acl";

/** The Excalidraw `.excalidraw` JSON media type (`application/vnd.excalidraw+json`). */
export const EXCALIDRAW_MIME = "application/vnd.excalidraw+json";
const TURTLE = "text/turtle";

/** The plain shape Excalidraw saves/loads — elements + appState + files. */
export interface SceneState {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}

/** Config for a pod-backed scene store. */
export interface SolidStoreConfig {
  /**
   * The `…/drawings/` container URL the store reads/writes under. MUST end with `/`.
   * Made owner-private (fail-closed) before any write.
   */
  container: string;
  /** The owner's WebID — written into each resource's owner-only ACL. */
  webId: string;
  /** An authenticated `fetch` (defaults to `globalThis.fetch`). */
  fetch?: typeof globalThis.fetch;
  /**
   * Serialise (elements, appState, files) to the byte-exact `.excalidraw` body.
   * Injected so the store doesn't import Excalidraw's whole `data/json` graph (and
   * is unit-testable). The app wires Excalidraw's real `serializeAsJSON(…, "local")` —
   * the self-contained `.excalidraw` JSON (files inline). The sibling image blobs are
   * written additionally as individually-WAC-able pod resources; the byte-exact body
   * alone is sufficient to reconstitute the scene on load.
   */
  serialize: (state: SceneState) => string;
}

/** A board identifier — a filesystem-safe slug naming one scene under the container. */
export type BoardId = string;

const SLUG_OK = /^[A-Za-z0-9._-]+$/;

/**
 * SolidStore — pod-backed `LocalData` save/load for ONE container of boards.
 */
export class SolidStore {
  private readonly container: string;
  private readonly webId: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly serialize: (state: SceneState) => string;
  /**
   * Memoised promise of the one-time container owner-only ACL establishment. Set on
   * the first write so the fail-closed container guard runs once per store; on
   * failure it is dropped so the next write re-attempts it (never cached as "done").
   */
  private containerAcl: Promise<void> | undefined;

  constructor(config: SolidStoreConfig) {
    if (!config.container.endsWith("/")) {
      throw new Error(
        "SolidStore container URL must end with a trailing slash",
      );
    }
    if (!/^https?:\/\//.test(config.webId)) {
      throw new Error("SolidStore webId must be an http(s) IRI");
    }
    this.container = config.container;
    this.webId = config.webId;
    this.fetchFn = (config.fetch ?? globalThis.fetch).bind(globalThis);
    this.serialize = config.serialize;
  }

  /** The byte-exact `.excalidraw` scene resource URL for a board. */
  sceneUrl(board: BoardId): string {
    return `${this.container}${assertSlug(board)}.excalidraw`;
  }

  /** The `draw:Scene` RDF descriptor URL for a board. */
  descriptorUrl(board: BoardId): string {
    return `${this.container}${assertSlug(board)}.ttl`;
  }

  /**
   * The sibling-image-resource URL for one `fileId` of a board. Files live in a
   * per-board sub-path so two boards can hold an image with the same id without
   * collision, and so a board's files are listable/clearable together.
   */
  fileUrl(board: BoardId, fileId: FileId): string {
    return `${this.container}${assertSlug(board)}.files/${assertSlug(fileId)}`;
  }

  /**
   * Establish the container's owner-only ACL — FAIL-CLOSED, exactly once per store
   * (memoised). Keystone of the owner-only guarantee: the `acl:default` clause means
   * every scene/descriptor/image created inside inherits owner-only access during the
   * brief body→`.acl` window. On failure the memo is dropped (retryable) and the
   * error propagates so no write proceeds into an unprovably-private container.
   */
  ensureContainerAcl(): Promise<void> {
    if (!this.containerAcl) {
      this.containerAcl = establishContainerAcl(
        this.fetchFn,
        this.container,
        this.webId,
      ).catch((err) => {
        this.containerAcl = undefined; // don't cache a failure — retry next write.
        throw err;
      });
    }
    return this.containerAcl;
  }

  /**
   * Save a scene to the pod — the `LocalData.save` contract for ONE board.
   *
   * FAIL-CLOSED owner-only ordering:
   *   0. ensure the container owner-only ACL (with `acl:default`);
   *   1. write each image blob (body first, then its own `.acl`) — siblings;
   *   2. write the byte-exact `.excalidraw` scene body, then its own `.acl`;
   *   3. write the `draw:Scene` descriptor, then its own `.acl`.
   *
   * The scene body stays byte-exact (the opaque canvas); files are detached to
   * siblings BEFORE serialising so the canvas JSON is small.
   */
  async saveScene(
    board: BoardId,
    state: SceneState,
    meta?: { title?: string; keepalive?: boolean },
  ): Promise<void> {
    // keepalive: a best-effort flag for the unload path — the scene/descriptor body PUTs are
    // marked `keepalive` so the browser may complete them after the page goes away (subject
    // to the 64KB keepalive cap; large scenes simply fall back to a normal request).
    const keepalive = meta?.keepalive === true;
    await this.ensureContainerAcl();

    // 1. Image blobs → sibling resources (body-first, then per-resource ACL).
    for (const [id, file] of Object.entries(state.files) as [
      FileId,
      BinaryFileData,
    ][]) {
      await this.writeFile(board, id, file);
    }

    // 2. Byte-exact scene body. The app serialises with `type: "local"` — the
    //    self-contained `.excalidraw` JSON the editor reads back via its normal import
    //    path. The store keeps it byte-for-byte (opaque); the sibling blobs above are
    //    additional WAC-able resources, not required for fidelity.
    const body = this.serialize(state);
    const sceneUrl = this.sceneUrl(board);
    await this.putBody(sceneUrl, body, EXCALIDRAW_MIME, keepalive);
    await putResourceAcl(this.fetchFn, sceneUrl, this.webId);

    // 3. The small RDF descriptor pointing at the byte-exact scene resource.
    const now = new Date().toISOString();
    const descriptorUrl = this.descriptorUrl(board);
    const ttl = await serializeScene(descriptorUrl, {
      sceneDocument: sceneUrl,
      title: meta?.title ?? board,
      modified: now,
      schemaVersion: readSchemaVersion(body),
      viewBackgroundColor:
        typeof state.appState.viewBackgroundColor === "string"
          ? state.appState.viewBackgroundColor
          : undefined,
    });
    await this.putBody(descriptorUrl, ttl, TURTLE, keepalive);
    await putResourceAcl(this.fetchFn, descriptorUrl, this.webId);
  }

  /**
   * Load a scene from the pod — the boot-time load contract. Returns the raw
   * byte-exact `.excalidraw` JSON body plus the re-assembled `files` map, or
   * `undefined` when the board does not exist yet (a 404 — first run).
   *
   * The caller `JSON.parse`s + `restore`s the body (the editor's normal import path),
   * so the canvas stays opaque to this store.
   */
  async loadScene(
    board: BoardId,
  ): Promise<{ body: string; files: BinaryFiles } | undefined> {
    const sceneUrl = this.sceneUrl(board);
    const res = await this.fetchFn(sceneUrl, {
      headers: { accept: EXCALIDRAW_MIME },
    });
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      throw new Error(
        `loadScene: GET ${sceneUrl} -> ${res.status} ${res.statusText}`,
      );
    }
    const body = await res.text();

    // Re-assemble the sibling image blobs into the files map the editor expects.
    const fileIds = referencedFileIds(body);
    const files: BinaryFiles = {};
    for (const id of fileIds) {
      const file = await this.readFile(board, id);
      if (file) {
        files[id] = file;
      }
    }
    return { body, files };
  }

  /**
   * Read the `draw:Scene` RDF descriptor for a board (title / version / background /
   * sceneDocument). Returns `undefined` when there is no valid descriptor.
   */
  async loadDescriptor(board: BoardId) {
    const descriptorUrl = this.descriptorUrl(board);
    const res = await this.fetchFn(descriptorUrl, {
      headers: { accept: `${TURTLE}, application/ld+json;q=0.9` },
    });
    if (!res.ok) {
      return undefined;
    }
    const ttl = await res.text();
    return parseSceneTtl(descriptorUrl, ttl, res.headers.get("content-type"));
  }

  /** List the board ids in the container (parsed from `ldp:contains` via fetch-rdf). */
  async listBoards(): Promise<BoardId[]> {
    let result: Awaited<ReturnType<typeof fetchRdf>>;
    try {
      result = await fetchRdf(this.container, { fetch: this.fetchFn });
    } catch (err) {
      if (isNotFound(err)) {
        return [];
      }
      throw err;
    }
    const LDP_CONTAINS = "http://www.w3.org/ns/ldp#contains";
    const boards: BoardId[] = [];
    for (const q of result.dataset.match(null, null, null)) {
      if (
        q.predicate.value === LDP_CONTAINS &&
        q.object.termType === "NamedNode"
      ) {
        const child = q.object.value;
        if (!child.startsWith(this.container)) {
          continue;
        }
        const rest = child.slice(this.container.length);
        // Only the byte-exact scene resources name a board.
        if (rest.endsWith(".excalidraw") && !rest.includes("/")) {
          boards.push(rest.slice(0, -".excalidraw".length));
        }
      }
    }
    return boards;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Write one image blob as a sibling resource — body first, then its own owner-only
   * `.acl`. The base64 `dataURL` is decoded to raw bytes and stored as the image's
   * own MIME type, so the sibling is a real, individually-WAC-able pod image resource.
   */
  private async writeFile(
    board: BoardId,
    id: FileId,
    file: BinaryFileData,
  ): Promise<void> {
    const { mime, bytes } = decodeDataUrl(file.dataURL);
    const url = this.fileUrl(board, id);
    const res = await this.fetchFn(url, {
      method: "PUT",
      headers: { "content-type": mime || file.mimeType },
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new Error(
        `writeFile: PUT ${url} -> ${res.status} ${res.statusText}`,
      );
    }
    await putResourceAcl(this.fetchFn, url, this.webId);
  }

  /** Read one sibling image blob back into a `BinaryFileData` (re-encoded to a dataURL). */
  private async readFile(
    board: BoardId,
    id: FileId,
  ): Promise<BinaryFileData | undefined> {
    const url = this.fileUrl(board, id);
    const res = await this.fetchFn(url);
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      throw new Error(
        `readFile: GET ${url} -> ${res.status} ${res.statusText}`,
      );
    }
    const mime = res.headers.get("content-type") ?? "application/octet-stream";
    const buf = new Uint8Array(await res.arrayBuffer());
    const dataURL = `data:${mime};base64,${base64Encode(buf)}`;
    return {
      id,
      mimeType: mime as BinaryFileData["mimeType"],
      dataURL: dataURL as BinaryFileData["dataURL"],
      created: Date.now(),
    };
  }

  /**
   * PUT a text body to a resource, throwing on a non-2xx. `keepalive` (unload path) asks the
   * browser to keep the request alive past page teardown — best-effort, subject to the 64KB
   * keepalive body cap.
   */
  private async putBody(
    url: string,
    body: string,
    contentType: string,
    keepalive = false,
  ): Promise<void> {
    const res = await this.fetchFn(url, {
      method: "PUT",
      headers: { "content-type": contentType },
      body,
      ...(keepalive ? { keepalive: true } : {}),
    });
    if (!res.ok) {
      throw new Error(`PUT ${url} -> ${res.status} ${res.statusText}`);
    }
  }
}

/** Validate a board id / file id is a safe single-path-segment slug (no traversal). */
function assertSlug(slug: string): string {
  if (!SLUG_OK.test(slug) || slug === "." || slug === "..") {
    throw new Error(`unsafe slug (must match ${SLUG_OK}): ${slug}`);
  }
  return slug;
}

/**
 * Read the `version` field out of a serialised `.excalidraw` body without parsing the
 * whole (potentially large) canvas as a parsed model. Returns the version as a string,
 * or `undefined`. The body is opaque to the store otherwise.
 */
function readSchemaVersion(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { version?: unknown };
    return parsed.version != null ? String(parsed.version) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract the set of image `fileId`s referenced by the elements in a serialised scene
 * body, so load knows which sibling blobs to fetch. Image elements carry a `fileId`;
 * we read it from the opaque JSON without depending on the element type internals.
 */
function referencedFileIds(body: string): FileId[] {
  try {
    const parsed = JSON.parse(body) as {
      elements?: Array<{ fileId?: unknown; isDeleted?: unknown }>;
    };
    const ids = new Set<string>();
    for (const el of parsed.elements ?? []) {
      if (el && typeof el.fileId === "string" && el.isDeleted !== true) {
        ids.add(el.fileId);
      }
    }
    return [...ids] as FileId[];
  } catch {
    return [];
  }
}

/** Decode a `data:<mime>;base64,<payload>` URL into its MIME type + raw bytes. */
function decodeDataUrl(dataURL: string): { mime: string; bytes: Uint8Array } {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataURL);
  if (!match) {
    throw new Error("decodeDataUrl: not a data: URL");
  }
  const mime = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3];
  if (isBase64) {
    return { mime, bytes: base64Decode(payload) };
  }
  return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}

/** Base64-decode to bytes (browser `atob`, with a Buffer fallback for Node tests). */
function base64Decode(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Base64-encode bytes (browser `btoa`, with a Buffer fallback for Node tests). */
function base64Encode(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

function isNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err) {
    return (err as { status?: number }).status === 404;
  }
  return false;
}
