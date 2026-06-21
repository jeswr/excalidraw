<!-- AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate. -->
# Excalidraw → Solid pod persistence

This subtree adds **Solid pod persistence** to the Excalidraw example app
(`excalidraw-app/`). It replaces the browser-local storage seam (`LocalData`,
localStorage + IndexedDB) with a pod-backed store: one **byte-exact `.excalidraw`
scene resource per board** under the user's pod `…/drawings/` container, with image
blobs as sibling resources and a small `draw:Scene` RDF descriptor alongside.

> Fork of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) (MIT).
> The Solid integration is part of the `@jeswr` Solid app suite — experimental,
> AI-agent-generated, under active development.

## What it stores

| Resource | What | Format |
|---|---|---|
| `…/drawings/<board>.excalidraw` | the **byte-exact** canvas (elements + appState) | `application/vnd.excalidraw+json` (opaque, never shredded) |
| `…/drawings/<board>.files/<id>` | one image blob per `fileId` | the image's own MIME (decoded from the base64 dataURL) |
| `…/drawings/<board>.ttl` | the `draw:Scene` descriptor | Turtle — title / created / modified / schemaVersion / viewBackgroundColor + `draw:sceneDocument` → the `.excalidraw` resource |

The canvas stays **opaque**: the store writes/reads the `.excalidraw` body byte-for-byte
and the editor `JSON.parse`+`restore`s it through its normal import path. Only the
lightweight descriptor is RDF, built with [`@jeswr/solid-drawing`](https://github.com/jeswr/solid-drawing)
and read back via [`@jeswr/fetch-rdf`](https://github.com/jeswr/fetch-rdf). The KV
plumbing is [`@jeswr/unstorage-solid`](https://github.com/jeswr/unstorage-solid)'s
LDP-over-pod model.

## Modules

| File | Role |
|---|---|
| `SolidStore.ts` | the pod scene store — `saveScene` / `loadScene` / `loadDescriptor` / `listBoards`; byte-exact scene + sibling images + descriptor; fail-closed owner-only ordering |
| `acl.ts` | owner-only WAC ACL writer — fail-closed, with positive validation of the "already owner-private" 405 escape path |
| `controller.ts` | the additive, fail-soft bridge from `LocalData.save` → debounced pod mirror |
| `session.ts` | reactive-auth wiring + **silent session restore** (no popup on load) + WebID/storage-root/container resolution |
| `clientid-document.ts` | the **origin-aware** Solid Client Identifier Document (`fedapp:App` block) |
| `federation.ts` | the `fedreg:Membership(status:Active)` registry builder |
| `webid-token-provider.ts`, `login-ux.ts` | **vendored** WebID-first DPoP login (static `client_id`) from the suite skill |

## Security / hardening invariants

These are load-bearing — see the module TSDoc for the full contract.

- **Owner-only WAC ACL, FAIL-CLOSED.** The `…/drawings/` container is made owner-private
  once up front (`acl:accessTo` + `acl:default`) BEFORE any body is written. If the ACL
  can't be established **or POSITIVELY confirmed** owner-only, the store refuses to write.
  Per resource: BODY first, then its `.acl`; `putResourceAcl` THROWS on any non-2xx
  except a documented 405 (whose data is already secured by the container default). The
  "already owner-private" 405 escape path is validated POSITIVELY — owner R/W/C over both
  `accessTo` and `default`, and NO agentClass / foreign-agent grant anywhere.
- **Silent session restore, no popup on load.** `silentRestore()` redeems the persisted
  DPoP refresh token via a refresh-grant token-endpoint fetch — never a popup / redirect /
  iframe. Interactive login fires only on an explicit user action.
- **Origin-aware `client_id`.** Every origin-bearing field is derived from one `origin`
  argument, so the served `client_id` equals the served URL byte-for-byte at any deploy
  origin. Regenerate `public/clientid.jsonld` per origin with `EXCALIDRAW_SOLID_ORIGIN`.
- **Path-traversal-safe slugs.** Board / file ids must be a single safe path segment.

## Federation

- **Sector:** `https://w3id.org/jeswr/sectors/drawing#sector`
- **Produces / consumes shape:** `https://w3id.org/jeswr/drawing#Scene`
- **`client_id` (canonical prod):** `https://excalidraw.jeswr.org/clientid.jsonld`
- **Membership:** `public/federation/registry.ttl` — a `fedreg:Membership(status:Active)`.

> **NEEDS:USER** — `fedreg:assertedBy` is a flagged placeholder
> (`https://jeswr.solidcommunity.net/profile/card#me`). Replace it with the maintainer /
> registry-operator WebID and re-issue the membership before the registry goes live.

## Regenerating the committed artifacts

```sh
EXCALIDRAW_SOLID_ORIGIN=https://your-origin.example \
  node excalidraw-app/data/solid/generate-federation-artifacts.mjs
```

Writes `public/clientid.jsonld` + `public/federation/registry.ttl` for that origin.

## Gate

```sh
npx vitest run excalidraw-app/data/solid/        # integration tests (scene↔pod roundtrip, fail-closed ACL, federation)
npx eslint --max-warnings=0 --ext .ts excalidraw-app/data/solid/
npx tsc -p excalidraw-app/data/solid/tsconfig.json   # 0 errors in this subtree (upstream packages/** carry their own vite-types errors)
```

The Solid integration is gate-scoped to this subtree (the full upstream Excalidraw
typecheck/build is large and carries its own vite-client-types expectations).
