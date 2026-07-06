// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Federation registration for the Excalidraw→Solid fork.
 *
 * The fork participates in the `@jeswr` Solid federation two ways:
 *   1. SELF-DESCRIPTION — the `fedapp:App` block in `clientid.jsonld` (see
 *      `clientid-document.ts`): the app declares its sector + the shape it produces.
 *      That is a SELF-asserted claim and is never trusted as a membership on its own.
 *   2. MEMBERSHIP — a `fedreg:Membership(status:Active)` record, built here via
 *      `@jeswr/federation-registry`'s `buildRegistry`. A membership is the REGISTRY's
 *      assertion (it carries `fedreg:assertedBy` + a lifecycle status), so a consumer
 *      can trust the listing rather than a bag of self-asserted app documents.
 *
 * RDF discipline: the registry/membership graph is built + serialised by
 * `@jeswr/federation-registry` (n3.Writer under the hood). No hand-built triples.
 */

import { buildRegistry } from "@jeswr/federation-registry";

/**
 * The maintainer WebID that asserts the fork's federation membership
 * (set at go-live 2026-07-06; previously a flagged placeholder).
 */
export const MAINTAINER_ASSERTED_BY = "https://jeswr.org/#me";

/** Inputs for building the fork's federation registry document. */
export interface FederationRegistryInput {
  /** The registry document's own IRI (where it is published). */
  registryId: string;
  /** The fork's `client_id` (its `clientid.jsonld` URL at the deploy origin). */
  clientId: string;
  /** The WebID asserting the membership (defaults to the flagged placeholder). */
  assertedBy?: string;
  /** The membership record's IRI (optional; a blank node is minted when omitted). */
  membershipId?: string;
}

/**
 * Build the fork's `fedreg:Registry` document with one `Active` membership for its
 * `client_id`. Returns the registry graph object (`.quads`, `.toString(format?)`).
 */
export function buildForkRegistry(input: FederationRegistryInput) {
  return buildRegistry({
    id: input.registryId,
    members: [
      {
        id: input.membershipId,
        app: input.clientId,
        status: "Active",
        assertedBy: input.assertedBy ?? MAINTAINER_ASSERTED_BY,
      },
    ],
  });
}

/** Serialise the fork's registry document to Turtle. */
export function serializeForkRegistry(
  input: FederationRegistryInput,
): Promise<string> {
  return buildForkRegistry(input).toString();
}
