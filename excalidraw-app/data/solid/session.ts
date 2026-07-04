// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Solid session wiring for the Excalidraw→Solid fork.
 *
 * AUTH MODEL. Two paths produce a SCOPED authenticated `fetch` the pod store uses — NEITHER
 * patches `globalThis.fetch` (round-3 HIGH fix; see below):
 *   - INTERACTIVE login ({@link interactiveLogin}) builds a `ReactiveFetchManager` with a
 *     WebID-first DPoP token provider and installs its SCOPED `manager.fetch` accessor (NOT
 *     `registerGlobally()`). That scoped fetch upgrades a request that gets a 401 from a pod
 *     by attaching a DPoP-bound token (the popup fires there), and is installed as the
 *     session fetch via {@link setSolidFetch}. `globalThis.fetch` is left untouched.
 *   - SILENT restore ({@link silentRestore}) has NO reactive manager — it redeems the
 *     persisted refresh token and builds a DPoP-attaching fetch from the restored
 *     credential ({@link dpopAuthedFetch}), installing THAT as the session fetch.
 * {@link solidFetch} returns whichever is installed (NOT the bare global — that was the
 * round-1 bug that left restored sessions un-authed). We track the WebID separately so the
 * rest of the app knows a pod is connected and where to write.
 *
 * SCOPED-FETCH RULE (round-3 HIGH fix). `registerGlobally()` was the round-1/2 mechanism —
 * it replaces `globalThis.fetch` with the manager's reactive fetch. That leaked: after a
 * {@link disconnectSolid} the patched global SURVIVED, so unrelated app fetches kept being
 * intercepted/auth-upgraded with the dead Solid provider, and each repeated connect STACKED
 * another global manager. The fix uses the manager's SCOPED `fetch` accessor (a bound
 * reactive fetch that does the 401→upgrade logic without touching the global) stored ONLY in
 * {@link solidFetch} and used solely by the `SolidStore` / pod calls. After
 * {@link disconnectSolid}, `globalThis.fetch` is the original (it was never patched) and no
 * Solid provider intercepts unrelated requests; repeated connect/disconnect cannot stack
 * global managers. (The cleaner of the two options the review proposed — the global-restore
 * fallback was unnecessary because reactive-auth exposes a scoped `manager.fetch`.)
 *
 * SILENT SESSION RESTORE (cross-app UX invariant #1, a HARDENING RULE here):
 * {@link silentRestore} re-establishes a session on load from the persisted DPoP
 * refresh token via `@jeswr/solid-session-restore` — a refresh-grant token-endpoint
 * fetch, NEVER a popup/redirect/iframe. On any failure it returns `null` (stays
 * logged-out); an interactive login is deferred to an EXPLICIT user action, never
 * triggered automatically during page load.
 *
 * Browser-only (reactive-auth defines custom elements + opens popups); import from
 * client code only.
 */

import { fetchRdf } from "@jeswr/fetch-rdf";
import { generateProof } from "dpop";

import type { RestoredSession } from "@jeswr/solid-session-restore";

/** The current Solid WebID, or `null` when no pod is connected. */
let currentWebId: string | null = null;
/** The pod base container the fork writes drawings under (set on connect). */
let currentDrawingsContainer: string | null = null;
/**
 * The authenticated `fetch` for pod requests. `null` until a session is established.
 *
 * Two paths install it, NEITHER patching `globalThis.fetch`:
 *   - INTERACTIVE login installs the SCOPED `ReactiveFetchManager.fetch` accessor (a bound
 *     reactive fetch that attaches DPoP-bound tokens on a 401) — NOT `registerGlobally()`.
 *   - SILENT restore has NO reactive manager; it builds a DPoP-attaching fetch from the
 *     restored credential ({@link dpopAuthedFetch}) and installs it here.
 *
 * Pod writes go through {@link solidFetch}, which returns THIS once set (so a restored
 * session's requests are actually authenticated — the round-1 bug was returning the bare
 * unauthenticated global, leaving silent-restore saves/loads un-authed).
 */
let currentFetch: typeof globalThis.fetch | null = null;

/** The conventional sub-container the fork owns under the pod storage root. */
export const DRAWINGS_NAMESPACE = "drawings/";

/** localStorage key persisting the last-connected WebID (UI affordance only). */
export const SOLID_WEBID_KEY = "excalidraw-solid-webid";
/**
 * The credential-free remembered-account pointer (WebID→issuer) that
 * `@jeswr/solid-session-restore` reads on load to pick which issuer to silently
 * restore. App-scoped per the package's per-app-pointer rule.
 */
export const REMEMBERED_ACCOUNT_KEY = "excalidraw-solid.remembered-account";
/**
 * The per-app IndexedDB database holding the DPoP-bound refresh-token credential that
 * silent restore redeems. App-scoped (two apps on one origin never share a store).
 */
export const SESSION_DB_NAME = "excalidraw-solid:sessions";

/**
 * The authenticated `fetch` for pod requests. Returns the session-installed authed fetch
 * once one is set (silent-restore credential fetch OR the interactive path's SCOPED
 * `manager.fetch`); before any session it falls back to the bare global (used only for
 * PUBLIC reads such as dereferencing a WebID profile during connect). The global is never
 * patched, so this is the ONLY surface through which Solid auth is applied.
 */
export function solidFetch(): typeof globalThis.fetch {
  if (currentFetch) {
    return currentFetch;
  }
  return (globalThis.fetch ?? fetch).bind(globalThis);
}

/**
 * Install the authenticated `fetch` for the live session. The interactive-login path
 * passes the reactive-auth manager's SCOPED `fetch` (NOT the patched global); the
 * silent-restore path passes a DPoP-attaching fetch built from the restored credential.
 * Pass `null` to revert to the bare global (disconnect).
 */
export function setSolidFetch(fetchImpl: typeof globalThis.fetch | null): void {
  currentFetch = fetchImpl;
}

/**
 * Build a DPoP-attaching `fetch` from a restored session credential. Each request gets a
 * freshly minted RFC 9449 DPoP proof bound to the session's `dpopKey` and the request's
 * method + URL (the `accessToken` is passed so the proof carries the `ath` claim), plus
 * the `Authorization: DPoP <accessToken>` header. This mirrors the token provider's
 * `upgrade()`, but applies it UNCONDITIONALLY (not on a 401) since we already hold a live
 * credential from the refresh grant.
 *
 * The proof's `htu`/`htm` must match the request actually sent, so we resolve the input to
 * a concrete method + URL and rebuild the `Request` with the auth headers.
 */
export function dpopAuthedFetch(
  session: Pick<RestoredSession, "accessToken" | "dpopKey">,
): typeof globalThis.fetch {
  const base = (globalThis.fetch ?? fetch).bind(globalThis);
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const url = request.url;
    const method = request.method;
    const proof = await generateProof(
      session.dpopKey,
      url,
      method,
      undefined,
      session.accessToken,
    );
    const headers = new Headers(request.headers);
    headers.set("DPoP", proof);
    headers.set("Authorization", `DPoP ${session.accessToken}`);
    return base(new Request(request, { headers }));
  };
}

/** The connected WebID, or `null`. */
export function solidWebId(): string | null {
  return currentWebId;
}

/** The `…/drawings/` container the fork writes under, or `null` when no pod is connected. */
export function drawingsContainer(): string | null {
  return currentDrawingsContainer;
}

/** True once a pod session is connected (a WebID is known). */
export function solidConnected(): boolean {
  return currentWebId !== null && currentDrawingsContainer !== null;
}

/** The static Client Identifier Document URL — origin-aware (`/clientid.jsonld`). */
export function clientIdDocumentUrl(): string {
  return new URL(
    "/clientid.jsonld",
    globalThis.location?.href ?? "http://localhost/",
  ).toString();
}

/**
 * Validate + normalise an UNTRUSTED `pim:storage` object value (read from a WebID
 * profile — the profile owner, or an attacker who can write to it, fully controls this
 * string) into a canonical container root: an absolute http(s) URL with no query/fragment
 * and a path ending in `/`. Returns `null` (never throws) on anything that fails to parse
 * or isn't a clean container address, so the caller can skip it and fall through to the
 * origin-root default.
 *
 * SECURITY (raw-string `endsWith` bypass fix). The prior implementation did
 * `root.endsWith("/")` on the RAW string and concatenated it onward unparsed. A hostile
 * `pim:storage` value such as `https://evil.example/x?y=/` or `https://evil.example/x#/`
 * ends with `/` as a STRING (the query/fragment does) without the path being a container
 * at all — `endsWith` never parses the URL to see that. That smuggled query/fragment then
 * rode onward into the drawings-container concat (`${root}${DRAWINGS_NAMESPACE}`) and
 * every subsequent pod-resource URL built from it, silently landing requests at whatever
 * path/resource the query or fragment actually pointed to. Parsing via `new URL()` FIRST
 * and validating the PARSED `pathname` (never the raw string, and rejecting any
 * search/hash outright rather than trying to strip-and-salvage them) closes that: a
 * query/fragment can never masquerade as a directory boundary.
 */
function normalizeStorageRoot(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.search !== "" || url.hash !== "") {
    return null;
  }
  const pathname = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  // Reconstructed from the parsed origin + pathname only — never the raw string — so
  // nothing else that may have ridden along in `value` (userinfo, a stray query/hash
  // the checks above already reject, etc.) can survive into the returned root.
  return `${url.origin}${pathname}`;
}

/**
 * Resolve the pod storage root for a WebID by dereferencing its profile and reading
 * `pim:storage`. Falls back to the WebID origin root when none is advertised, or when
 * every advertised value fails validation ({@link normalizeStorageRoot}). Returns a URL
 * ending in `/`. Uses the injected (authed) fetch so a private profile resolves.
 */
export async function resolveStorageRoot(
  webId: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const PIM_STORAGE = "http://www.w3.org/ns/pim/space#storage";
  try {
    const { dataset } = await fetchRdf(webId, { fetch: fetchImpl });
    for (const q of dataset.match(null, null, null)) {
      if (
        q.predicate.value === PIM_STORAGE &&
        q.object.termType === "NamedNode"
      ) {
        const normalized = normalizeStorageRoot(q.object.value);
        if (normalized) {
          return normalized;
        }
        // malformed/untrusted value — skip it, keep scanning the remaining quads (and
        // fall through to the origin-root default below if nothing else validates).
      }
    }
  } catch {
    // fall through to the origin-root default.
  }
  const u = new URL(webId);
  return `${u.origin}/`;
}

/**
 * Resolve a WebID's OIDC issuer (`solid:oidcIssuer`) from its profile. Throws an
 * actionable error when the profile advertises no http(s) issuer. When several are
 * listed, the first http(s) one is used.
 */
export async function resolveOidcIssuer(
  webId: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const SOLID_OIDC_ISSUER = "http://www.w3.org/ns/solid/terms#oidcIssuer";
  const { dataset } = await fetchRdf(webId, { fetch: fetchImpl });
  for (const q of dataset.match(null, null, null)) {
    if (
      q.predicate.value === SOLID_OIDC_ISSUER &&
      q.object.termType === "NamedNode" &&
      /^https?:\/\//.test(q.object.value)
    ) {
      return q.object.value;
    }
  }
  throw new Error(
    `This WebID can't be used for Solid login — its profile has no solid:oidcIssuer (${webId})`,
  );
}

/**
 * Attempt a SILENT Solid session restore on load — refresh-grant only, NEVER a popup
 * or redirect (cross-app UX invariant #1). Reads the credential-free remembered
 * pointer to find the last WebID + issuer, then redeems the persisted DPoP-bound
 * refresh token via `restoreSession` (a token-endpoint fetch — no window/iframe). The
 * decision (`decideSilentRestore`) re-checks the restored WebID equals the remembered
 * one (WebID-scoped isolation, fail-closed).
 *
 * Returns the restored WebID on success (the caller then connects pod state), or
 * `null` when there is nothing to restore / the credential is dead / it failed.
 * CRUCIALLY it NEVER opens an interactive login: on failure the user is left
 * logged-out and login is deferred to an explicit action. Doomed pointers are dropped
 * per the package's keep/drop matrix so they are not retried forever.
 */
export async function silentRestore(): Promise<string | null> {
  // Browser-only: IndexedDB + localStorage are required; bail (no popup) otherwise.
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const {
      IndexedDbSessionStore,
      RememberedAccount,
      decideSilentRestore,
      indexedDbAvailable,
      restoreSession,
      shouldDropRememberedPointer,
      hasPersisted,
    } = await import("@jeswr/solid-session-restore");

    if (!indexedDbAvailable()) {
      return null;
    }

    const pointer = new RememberedAccount(REMEMBERED_ACCOUNT_KEY);
    const remembered = pointer.read();
    // Nothing remembered ⇒ nothing to restore silently. Do NOT popup — stay logged-out.
    if (!remembered) {
      return null;
    }

    const store = new IndexedDbSessionStore({ dbName: SESSION_DB_NAME });
    const clientId = clientIdDocumentUrl();

    // Hold the restored credential the successful restore yields so we can install a
    // DPoP-attaching authed fetch BEFORE connecting (resolveStorageRoot/issuer then read
    // a possibly-private profile authenticated, and every later pod write is authed).
    let restored: RestoredSession | undefined;

    // The single refresh-grant restore the decision drives — a token-endpoint fetch
    // ONLY, never a popup/iframe.
    const decision = await decideSilentRestore({
      lastActiveWebId: remembered.webId,
      remembered: [remembered],
      restoreIssuer: async (issuer: string) => {
        const session = await restoreSession({
          store,
          issuer: new URL(issuer),
          clientId,
          // Discovery + the grant use the bare (un-authed) global; the token endpoint
          // needs no bearer. We capture the resulting credential for the authed fetch.
          fetch: (globalThis.fetch ?? fetch).bind(globalThis),
        });
        if (session) {
          restored = session;
          return { webId: session.webId };
        }
        return undefined;
      },
    });

    if (decision.outcome === "restored" && restored) {
      // Install the DPoP-authed fetch BUILT FROM THE RESTORED CREDENTIAL — this is the
      // load-bearing fix: silent-restore pod requests are now genuinely authenticated.
      setSolidFetch(dpopAuthedFetch(restored));
      await connectSolid(decision.webId);
      return decision.webId;
    }

    // LOGIN outcome (or restored-without-credential, treated the same): never auto-popup.
    // Drop a doomed pointer per the keep/drop matrix so it isn't retried forever; a
    // transient blip keeps it.
    if (decision.outcome === "login") {
      const issuer = remembered.issuer;
      const presence = issuer
        ? await hasPersisted(store, new URL(issuer))
        : "absent";
      if (shouldDropRememberedPointer(decision.reason, presence)) {
        pointer.clear();
      }
    }
    return null;
  } catch (err) {
    // Fail-closed: any unexpected error ⇒ logged-out, NO popup.
    // eslint-disable-next-line no-console
    console.warn(
      "[solid] silent restore failed; staying logged-out (no popup):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Connect a Solid pod: record the WebID, resolve the `…/drawings/` container, persist
 * the WebID + the credential-free remembered pointer (for next-load silent restore).
 * The authed fetch is whatever the caller installed via {@link setSolidFetch} — the
 * interactive path's SCOPED `manager.fetch` or silent restore's `dpopAuthedFetch` — read
 * here via {@link solidFetch}; no token is stored.
 */
export async function connectSolid(webId: string): Promise<void> {
  const fetchImpl = solidFetch();
  const root = await resolveStorageRoot(webId, fetchImpl);
  currentWebId = webId;
  // `root` is already a validated, parsed container root (see resolveStorageRoot /
  // normalizeStorageRoot) — resolve the sub-container via `new URL()` rather than string
  // concat so the same defence-in-depth applies here too.
  currentDrawingsContainer = new URL(DRAWINGS_NAMESPACE, root).toString();
  try {
    globalThis.localStorage?.setItem(SOLID_WEBID_KEY, webId);
  } catch {
    // localStorage unavailable (private mode) — the live connection still works.
  }
  // Best-effort: write the credential-free remembered pointer so a later reload can
  // attempt a SILENT refresh-grant restore. Holds NO token.
  try {
    const issuer = await resolveOidcIssuer(webId, fetchImpl);
    const { RememberedAccount } = await import("@jeswr/solid-session-restore");
    new RememberedAccount(REMEMBERED_ACCOUNT_KEY).write(webId, issuer);
  } catch {
    // issuer unresolved — silent restore simply won't run next load.
  }
}

/**
 * The redirect_uri the static Client Identifier Document must list — origin-aware so it
 * matches the served `client_id`'s `redirect_uris` byte-for-byte at any deploy origin.
 */
export function callbackUri(): string {
  return new URL(
    "/callback.html",
    globalThis.location?.href ?? "http://localhost/",
  ).toString();
}

/** Whether the current origin is a loopback dev host (enables insecure-loopback OIDC). */
function isLoopbackOrigin(): boolean {
  const host = globalThis.location?.hostname ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * INTERACTIVE Solid login — the ONLY place a popup/redirect is allowed (an explicit user
 * action, e.g. the "Connect Solid pod" button). Builds a reactive-auth manager with a
 * WebID-first DPoP token provider (static `client_id`) and installs its SCOPED `fetch`
 * accessor — which attaches DPoP-bound tokens on a 401 WITHOUT patching `globalThis.fetch`.
 * It asks the user for their WebID, then drives one authed request (the storage-root profile
 * read inside {@link connectSolid}) through that scoped fetch, which triggers the
 * authorization-code popup on the first 401. On success the scoped fetch is installed as the
 * session fetch and the pod state is connected; returns the connected WebID.
 *
 * IDEMPOTENT CONNECT (round-3 HIGH fix). Any prior session is cleared first via
 * {@link disconnectSolid} so a repeated connect cannot stack managers / leave a stale authed
 * fetch — each connect starts from a clean state and `globalThis.fetch` is never touched, so
 * a later disconnect leaves no Solid interception behind.
 *
 * Throws / rejects when the user cancels the WebID dialog or the authorization popup.
 *
 * Dynamically imports the (browser-only, custom-element-registering, oauth) login layer so
 * the rest of the module stays importable in non-browser/test contexts.
 */
export async function interactiveLogin(initialWebId?: string): Promise<string> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("interactiveLogin requires a browser environment");
  }
  // Idempotent connect: clear any prior session/fetch so repeated connects don't stack a
  // second manager or keep a stale authed fetch around. (No global was ever patched, so
  // there is nothing global to unwind — just our own state.)
  disconnectSolid();
  // Grab the manager + the custom-element class from the package barrel. We define the
  // element ourselves (idempotently) instead of importing the side-effect-only
  // `/registerElements` subpath, which the root tsconfig's `node` resolution can't see.
  const { ReactiveFetchManager, AuthorizationCodeFlow } = await import(
    "@solid/reactive-authentication"
  );
  if (!customElements.get("authorization-code-flow")) {
    customElements.define(
      "authorization-code-flow",
      AuthorizationCodeFlow as unknown as CustomElementConstructor,
    );
  }
  const { WebIdDPoPTokenProvider, promptWebIdDialog } = await import(
    "./webid-token-provider.js"
  );

  // Ask the user for their WebID up front (one dialog), then bind the provider to it so the
  // popup uses the issuer resolved from THAT WebID. Cancelling rejects here (no login).
  const webId = await promptWebIdDialog(
    initialWebId ?? persistedSolidWebId() ?? "",
  );

  // Mount (once) the <authorization-code-flow> element; its getCode drives the popup.
  type AuthCodeFlowElement = HTMLElement & {
    getCode: (uri: URL, signal: AbortSignal) => Promise<string>;
  };
  let ui = document.querySelector<AuthCodeFlowElement>(
    "authorization-code-flow",
  );
  if (!ui) {
    ui = document.createElement(
      "authorization-code-flow",
    ) as unknown as AuthCodeFlowElement;
    document.body.appendChild(ui);
  }
  const flow = ui;

  const provider = new WebIdDPoPTokenProvider(
    callbackUri(),
    (uri, signal) => flow.getCode(uri, signal),
    async () => webId,
    {
      clientId: clientIdDocumentUrl(),
      allowInsecureLoopback: isLoopbackOrigin(),
    },
  );
  const manager = new ReactiveFetchManager([provider]);

  // Install the manager's SCOPED reactive fetch (NOT registerGlobally()): it attaches DPoP
  // tokens on a 401 (the popup fires there) WITHOUT patching globalThis.fetch, so unrelated
  // app fetches are never intercepted and a later disconnect leaves no Solid interception
  // behind. connect's profile read + every pod write go through this scoped fetch via
  // solidFetch().
  setSolidFetch(manager.fetch);

  // connect performs an authed profile read → the first 401 triggers the authorization
  // popup; on success the WebID + container are recorded.
  await connectSolid(webId);
  return webId;
}

/**
 * Disconnect the pod: clear state + the scoped authed fetch + persisted WebID + remembered
 * pointer. Because the interactive path installs a SCOPED `manager.fetch` (never patches
 * `globalThis.fetch`), clearing `currentFetch` is sufficient — `solidFetch()` reverts to the
 * bare global and NO Solid provider intercepts unrelated requests afterward. There is no
 * global to restore and no manager left registered to stack on the next connect.
 */
export function disconnectSolid(): void {
  currentWebId = null;
  currentDrawingsContainer = null;
  currentFetch = null;
  try {
    globalThis.localStorage?.removeItem(SOLID_WEBID_KEY);
  } catch {
    // ignore
  }
  try {
    void import("@jeswr/solid-session-restore").then(
      ({ RememberedAccount }) => {
        new RememberedAccount(REMEMBERED_ACCOUNT_KEY).clear();
      },
    );
  } catch {
    // ignore — a stale pointer is harmless (silent restore fails closed).
  }
}

/** The last-connected WebID, if any (for a UI affordance). */
export function persistedSolidWebId(): string | null {
  try {
    return globalThis.localStorage?.getItem(SOLID_WEBID_KEY) ?? null;
  } catch {
    return null;
  }
}
