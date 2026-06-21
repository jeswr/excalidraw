// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Solid session wiring for the Excalidraw→Solid fork.
 *
 * AUTH MODEL: `@solid/reactive-authentication`'s patched global fetch. There is no
 * session object and no wrapped fetch — `ReactiveFetchManager.registerGlobally()`
 * upgrades every `fetch()` that gets a 401 from a pod by attaching a DPoP-bound token.
 * So the "authed fetch" handed to {@link SolidStore} is just `globalThis.fetch` once
 * the manager is registered. We track the WebID separately so the rest of the app
 * knows a pod is connected and where to write.
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

/** The current Solid WebID, or `null` when no pod is connected. */
let currentWebId: string | null = null;
/** The pod base container the fork writes drawings under (set on connect). */
let currentDrawingsContainer: string | null = null;

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

/** The authenticated `fetch` for pod requests (the global, once reactive-auth registered). */
export function solidFetch(): typeof globalThis.fetch {
  return (globalThis.fetch ?? fetch).bind(globalThis);
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
 * Resolve the pod storage root for a WebID by dereferencing its profile and reading
 * `pim:storage`. Falls back to the WebID origin root when none is advertised. Returns
 * a URL ending in `/`. Uses the injected (authed) fetch so a private profile resolves.
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
        const root = q.object.value;
        return root.endsWith("/") ? root : `${root}/`;
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
          fetch: solidFetch(),
        });
        return session ? { webId: session.webId } : undefined;
      },
    });

    if (decision.outcome === "restored") {
      await connectSolid(decision.webId);
      return decision.webId;
    }

    // LOGIN outcome: never auto-popup. Drop a doomed pointer per the keep/drop matrix
    // so it isn't retried forever; a transient blip keeps it.
    const issuer = remembered.issuer;
    const presence = issuer
      ? await hasPersisted(store, new URL(issuer))
      : "absent";
    if (shouldDropRememberedPointer(decision.reason, presence)) {
      pointer.clear();
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
 * The reactive-auth manager (registered by the caller) makes `globalThis.fetch` the
 * authed fetch, so no token is stored here.
 */
export async function connectSolid(webId: string): Promise<void> {
  const fetchImpl = solidFetch();
  const root = await resolveStorageRoot(webId, fetchImpl);
  currentWebId = webId;
  currentDrawingsContainer = `${root}${DRAWINGS_NAMESPACE}`;
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

/** Disconnect the pod: clear state + persisted WebID + remembered pointer. */
export function disconnectSolid(): void {
  currentWebId = null;
  currentDrawingsContainer = null;
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
