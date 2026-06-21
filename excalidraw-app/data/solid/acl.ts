// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Owner-only WAC ACL writer for the Excalidraw→Solid fork.
 *
 * OWNER-PRIVACY CONTRACT (load-bearing, FAIL-CLOSED). Every drawing the fork
 * persists is the user's own work — it is owner-PRIVATE by default. The ACL grants
 * ONLY the owner WebID `acl:Read`/`acl:Write`/`acl:Control` and nobody else. We
 * establish the owner-only ACL on the `…/drawings/` CONTAINER once up front, with
 * BOTH `acl:accessTo` (the container itself) AND `acl:default` (every resource
 * created inside it). The `acl:default` clause is the keystone: a `.excalidraw`
 * scene, its descriptor, and its image blobs all INHERIT owner-only access for the
 * brief window between a body being written and its own per-resource `.acl` landing,
 * so a drawing is never world-readable even momentarily.
 *
 * If the owner-only container ACL cannot be established or POSITIVELY confirmed, the
 * store REFUSES to write (throws) — fail-closed, never fail-open. The single accepted
 * "ACL not writable but already owner-private" path is a `405 Method Not Allowed` on
 * the `.acl` PUT combined with a POSITIVE proof that the existing container `.acl`
 * grants the owner full R/W/C over both `accessTo` and `default` and grants NO
 * agentClass or foreign agent. (See {@link containerIsAlreadyOwnerPrivate}.)
 *
 * RDF discipline (the suite house rule): the ACL is built with `n3`'s `DataFactory`
 * + `Writer` (typed quads, vetted serialiser) — NEVER a hand-concatenated triple
 * string. Reads parse via `@jeswr/fetch-rdf` (the suite's vetted parser).
 *
 * This mirrors the proven, roborev-vetted Linkding-fork `podStore` ACL design.
 */

import { fetchRdf } from "@jeswr/fetch-rdf";
import { DataFactory, Writer } from "n3";

const { namedNode, quad, blankNode } = DataFactory;

const ACL = "http://www.w3.org/ns/auth/acl#";
const FOAF = "http://xmlns.com/foaf/0.1/";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const HTTP_S_IRI = /^https?:\/\//;
const TURTLE = "text/turtle";

/**
 * Build an owner-only WAC ACL for a single RESOURCE (`acl:accessTo` only): the owner
 * gets Read/Write/Control over that resource, nobody else.
 */
export async function ownerOnlyResourceAcl(
  resourceUrl: string,
  ownerWebId: string,
): Promise<string> {
  assertWebId(ownerWebId);
  return buildAcl(ownerWebId, [
    { predicate: `${ACL}accessTo`, object: resourceUrl },
  ]);
}

/**
 * Build an owner-only WAC ACL for a CONTAINER, granting the owner Read/Write/Control
 * over the container itself (`acl:accessTo`) AND every resource created inside it
 * (`acl:default`) — and nobody else. The `acl:default` clause is what makes the
 * create→acl window safe (children inherit owner-only access).
 *
 * @param containerUrl the container URL (MUST end with `/`)
 * @param ownerWebId   the owner's WebID (MUST be an http(s) IRI)
 */
export async function ownerOnlyContainerAcl(
  containerUrl: string,
  ownerWebId: string,
): Promise<string> {
  if (!containerUrl.endsWith("/")) {
    throw new Error(
      `ownerOnlyContainerAcl: container must end with "/" (got ${containerUrl})`,
    );
  }
  assertWebId(ownerWebId);
  return buildAcl(ownerWebId, [
    { predicate: `${ACL}accessTo`, object: containerUrl },
    { predicate: `${ACL}default`, object: containerUrl },
  ]);
}

function assertWebId(ownerWebId: string): void {
  if (!HTTP_S_IRI.test(ownerWebId)) {
    throw new Error(`owner WebID must be an http(s) IRI (got ${ownerWebId})`);
  }
}

/** Shared owner-only authorization builder: owner gets Read/Write/Control, no one else. */
function buildAcl(
  ownerWebId: string,
  targets: { predicate: string; object: string }[],
): Promise<string> {
  const writer = new Writer({ prefixes: { acl: ACL, foaf: FOAF } });
  const authz = blankNode("owner");
  writer.addQuad(
    quad(authz, namedNode(RDF_TYPE), namedNode(`${ACL}Authorization`)),
  );
  for (const { predicate, object } of targets) {
    writer.addQuad(quad(authz, namedNode(predicate), namedNode(object)));
  }
  writer.addQuad(quad(authz, namedNode(`${ACL}agent`), namedNode(ownerWebId)));
  writer.addQuad(quad(authz, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`)));
  writer.addQuad(
    quad(authz, namedNode(`${ACL}mode`), namedNode(`${ACL}Write`)),
  );
  writer.addQuad(
    quad(authz, namedNode(`${ACL}mode`), namedNode(`${ACL}Control`)),
  );

  return new Promise<string>((resolve, reject) => {
    writer.end((error, result: string) =>
      error ? reject(error) : resolve(result),
    );
  });
}

/**
 * Establish the owner-only ACL on `container` — FAIL-CLOSED. PUTs an owner-only
 * container ACL (with `acl:default`) to `${container}.acl`. On success the container
 * (and everything created inside it) is owner-private.
 *
 * The ONLY accepted non-2xx is `405 Method Not Allowed` AND a POSITIVE confirmation
 * (via {@link containerIsAlreadyOwnerPrivate}) that the existing `.acl` is already
 * owner-only. Every other non-2xx (401/403/404/4xx/5xx/unconfirmable) THROWS, so the
 * caller never proceeds to write a drawing into a container we cannot prove is private.
 *
 * @param fetchImpl  an authenticated `fetch`
 * @param container  the container URL (MUST end with `/`)
 * @param ownerWebId the owner's WebID
 */
export async function establishContainerAcl(
  fetchImpl: typeof globalThis.fetch,
  container: string,
  ownerWebId: string,
): Promise<void> {
  const aclUrl = `${container}.acl`;
  const turtle = await ownerOnlyContainerAcl(container, ownerWebId);
  const res = await fetchImpl(aclUrl, {
    method: "PUT",
    headers: { "content-type": TURTLE },
    body: turtle,
  });
  if (res.ok) {
    return; // owner-only container ACL now in place.
  }
  // The single accepted exception: the server won't let us write the container `.acl`
  // (405) but we can fetch the existing one and POSITIVELY confirm it is owner-only.
  if (
    res.status === 405 &&
    (await containerIsAlreadyOwnerPrivate(
      fetchImpl,
      aclUrl,
      container,
      ownerWebId,
    ))
  ) {
    return;
  }
  throw new Error(
    `Refusing to store drawings: could not establish an owner-only ACL on the ` +
      `container ${container} (${res.status} ${res.statusText} on ${aclUrl}). ` +
      `Drawings are owner-private; aborting rather than risk a public container.`,
  );
}

/**
 * POSITIVELY confirm an EXISTING container `.acl` is owner-only. Fail-CLOSED positive
 * proof — NOT a negative "no public grant" heuristic. Returns `true` ONLY IF the
 * parsed `.acl`:
 *
 *   1. has SOME `acl:Authorization` granting the owner R+W+C over `acl:accessTo <container>`; AND
 *   2. has SOME `acl:Authorization` granting the owner R+W+C over `acl:default <container>`
 *      (this MAY be the SAME authorization as (1) or a different one — WAC validly
 *      splits access + default across two owner-only authorizations, so each coverage
 *      is proven INDEPENDENTLY); AND
 *   3. contains NO authorization (anywhere in the document) granting ANY `acl:agentClass`
 *      (foaf:Agent = public, acl:AuthenticatedAgent = any logged-in user) or any
 *      `acl:agent` OTHER than the owner.
 *
 * Anything not positively proven — an empty/unfetchable/unparseable ACL, missing
 * accessTo OR default owner coverage, a missing R/W/C mode, a foreign agent, or an
 * agentClass anywhere — returns `false` (fail closed). A single foreign/public grant
 * disqualifies the document even if a separate owner-only authorization also exists.
 */
export async function containerIsAlreadyOwnerPrivate(
  fetchImpl: typeof globalThis.fetch,
  aclUrl: string,
  container: string,
  ownerWebId: string,
): Promise<boolean> {
  let result: Awaited<ReturnType<typeof fetchRdf>>;
  try {
    result = await fetchRdf(aclUrl, { fetch: fetchImpl });
  } catch {
    return false; // can't read it → can't confirm → fail closed.
  }
  const dataset = result.dataset;
  const AUTHORIZATION = `${ACL}Authorization`;
  const ACCESS_TO = `${ACL}accessTo`;
  const DEFAULT = `${ACL}default`;
  const AGENT = `${ACL}agent`;
  const AGENT_CLASS = `${ACL}agentClass`;
  const MODE = `${ACL}mode`;
  const READ = `${ACL}Read`;
  const WRITE = `${ACL}Write`;
  const CONTROL = `${ACL}Control`;

  // FOREIGN-GRANT GUARD (checked first, fail-fast): any agentClass grant at all, or any
  // acl:agent that is NOT the owner, disqualifies the document — regardless of any
  // owner-only authorization that may also be present.
  if (dataset.match(null, namedNode(AGENT_CLASS), null).size > 0) {
    return false; // public (foaf:Agent) or authenticated (acl:AuthenticatedAgent).
  }
  for (const q of dataset.match(null, namedNode(AGENT), null)) {
    if (q.object.value !== ownerWebId) {
      return false; // a third-party agent grant.
    }
  }

  // POSITIVE PROOF, validated INDEPENDENTLY: the owner must have a complete R+W+C
  // authorization covering `acl:accessTo <container>` AND a complete R+W+C authorization
  // covering `acl:default <container>`. Each MAY be the same authz or two different ones.
  const containerNode = namedNode(container);
  const owner = namedNode(ownerWebId);
  const ownerHasFullControlOver = (targetPredicate: string): boolean => {
    for (const q of dataset.match(
      null,
      namedNode(RDF_TYPE),
      namedNode(AUTHORIZATION),
    )) {
      const authz = q.subject;
      const has = (
        predicate: string,
        object: ReturnType<typeof namedNode>,
      ): boolean => dataset.match(authz, namedNode(predicate), object).size > 0;
      if (
        has(targetPredicate, containerNode) &&
        has(AGENT, owner) &&
        has(MODE, namedNode(READ)) &&
        has(MODE, namedNode(WRITE)) &&
        has(MODE, namedNode(CONTROL))
      ) {
        return true;
      }
    }
    return false;
  };
  if (ownerHasFullControlOver(ACCESS_TO) && ownerHasFullControlOver(DEFAULT)) {
    return true; // positively proven owner-only for this container.
  }
  return false; // accessTo and/or default owner coverage missing → fail closed.
}

/**
 * Write the owner-only ACL for a RESOURCE — FAIL-CLOSED. A non-2xx is NOT swallowed.
 * The single accepted exception is `405 Method Not Allowed` (a server exposing no
 * writable per-resource `.acl`): acceptable ONLY because the resource already inherits
 * the container's owner-only `acl:default` (established fail-closed BEFORE any body was
 * written). Every other non-2xx — 401/403 (auth), 400/422 (rejected ACL), 5xx — THROWS,
 * so a drawing is never left under permissions we cannot vouch for.
 *
 * @param fetchImpl   an authenticated `fetch`
 * @param resourceUrl the resource URL (NOT the `.acl`)
 * @param ownerWebId  the owner's WebID
 */
export async function putResourceAcl(
  fetchImpl: typeof globalThis.fetch,
  resourceUrl: string,
  ownerWebId: string,
): Promise<void> {
  const aclUrl = `${resourceUrl}.acl`;
  const turtle = await ownerOnlyResourceAcl(resourceUrl, ownerWebId);
  const res = await fetchImpl(aclUrl, {
    method: "PUT",
    headers: { "content-type": TURTLE },
    body: turtle,
  });
  if (res.ok) {
    return;
  }
  // Documented "no writable per-resource .acl, fixed/inherited policy" signal —
  // acceptable ONLY because the container default already secures the resource.
  if (res.status === 405) {
    return;
  }
  throw new Error(
    `Refusing to leave a drawing without its owner-only ACL: ` +
      `${res.status} ${res.statusText} writing ${aclUrl}.`,
  );
}
