// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { describe, expect, it, vi } from "vitest";

import {
  containerIsAlreadyOwnerPrivate,
  establishContainerAcl,
  ownerOnlyContainerAcl,
  ownerOnlyResourceAcl,
  putResourceAcl,
} from "./acl";

const CONTAINER = "https://alice.pod.example/drawings/";
const RESOURCE = "https://alice.pod.example/drawings/board.excalidraw";
const WEBID = "https://alice.pod.example/profile/card#me";
const STRANGER = "https://mallory.evil.example/profile/card#me";

function ttlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/turtle" },
  });
}

describe("ownerOnlyContainerAcl", () => {
  it("grants ONLY the owner Read/Write/Control over accessTo + default", async () => {
    const ttl = await ownerOnlyContainerAcl(CONTAINER, WEBID);
    expect(ttl).toContain("acl:Authorization");
    expect(ttl).toContain(WEBID);
    expect(ttl).toContain(CONTAINER);
    expect(ttl).toContain("acl:Read");
    expect(ttl).toContain("acl:Write");
    expect(ttl).toContain("acl:Control");
    expect(ttl).toContain("acl:accessTo");
    expect(ttl).toContain("acl:default");
  });

  it("grants NOTHING public — no agentClass / foaf:Agent / AuthenticatedAgent", async () => {
    const ttl = await ownerOnlyContainerAcl(CONTAINER, WEBID);
    expect(ttl).not.toContain("agentClass");
    expect(ttl).not.toContain("foaf:Agent");
    expect(ttl).not.toContain("AuthenticatedAgent");
  });

  it("rejects a non-slash-terminated container (fail-closed)", async () => {
    await expect(
      ownerOnlyContainerAcl("https://alice.pod.example/drawings", WEBID),
    ).rejects.toThrow(/must end with/);
  });

  it("rejects a non-http(s) WebID (fail-closed)", async () => {
    await expect(
      ownerOnlyResourceAcl(RESOURCE, "mailto:alice@example.com"),
    ).rejects.toThrow(/http\(s\) IRI/);
  });
});

describe("ownerOnlyResourceAcl", () => {
  it("grants the owner R/W/C over accessTo only (no default for a leaf resource)", async () => {
    const ttl = await ownerOnlyResourceAcl(RESOURCE, WEBID);
    expect(ttl).toContain("acl:accessTo");
    expect(ttl).not.toContain("acl:default");
    expect(ttl).toContain(WEBID);
  });
});

describe("establishContainerAcl (fail-closed)", () => {
  it("PUTs an owner-only container .acl as text/turtle and resolves on 2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    await establishContainerAcl(
      fetchImpl as unknown as typeof fetch,
      CONTAINER,
      WEBID,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${CONTAINER}.acl`);
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "text/turtle",
    );
    const body = init.body as string;
    expect(body).toContain("acl:default");
    expect(body).toContain(WEBID);
  });

  it("THROWS (fail-closed) on a 403 — never silently leaves data inherited/public", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("nope", { status: 403, statusText: "Forbidden" }),
    );
    await expect(
      establishContainerAcl(
        fetchImpl as unknown as typeof fetch,
        CONTAINER,
        WEBID,
      ),
    ).rejects.toThrow(/could not establish an owner-only ACL/);
  });

  it("THROWS on a 404 (no escape path other than a CONFIRMED 405)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 404, statusText: "Not Found" }),
    );
    await expect(
      establishContainerAcl(
        fetchImpl as unknown as typeof fetch,
        CONTAINER,
        WEBID,
      ),
    ).rejects.toThrow(/could not establish an owner-only ACL/);
  });

  it("405 + a POSITIVELY-confirmed owner-only existing .acl is accepted", async () => {
    const existing = await ownerOnlyContainerAcl(CONTAINER, WEBID);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(null, {
          status: 405,
          statusText: "Method Not Allowed",
        });
      }
      return ttlResponse(existing); // the .acl GET inside containerIsAlreadyOwnerPrivate
    });
    await expect(
      establishContainerAcl(
        fetchImpl as unknown as typeof fetch,
        CONTAINER,
        WEBID,
      ),
    ).resolves.toBeUndefined();
  });

  it("405 + an existing .acl that grants a STRANGER FAILS CLOSED (positive validation)", async () => {
    // Build an ACL that has the full owner authorization PLUS a foreign-agent grant.
    const ownerAcl = await ownerOnlyContainerAcl(CONTAINER, WEBID);
    const withStranger = ownerAcl.replace(
      /\.\s*$/,
      `.\n<#stranger> a <http://www.w3.org/ns/auth/acl#Authorization>;\n  <http://www.w3.org/ns/auth/acl#accessTo> <${CONTAINER}>;\n  <http://www.w3.org/ns/auth/acl#agent> <${STRANGER}>;\n  <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read>.`,
    );
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(null, { status: 405 });
      }
      return ttlResponse(withStranger);
    });
    await expect(
      establishContainerAcl(
        fetchImpl as unknown as typeof fetch,
        CONTAINER,
        WEBID,
      ),
    ).rejects.toThrow(/could not establish an owner-only ACL/);
  });

  it("405 + an existing .acl with an agentClass (public) FAILS CLOSED", async () => {
    const ownerAcl = await ownerOnlyContainerAcl(CONTAINER, WEBID);
    const withPublic = ownerAcl.replace(
      /\.\s*$/,
      `.\n<#public> a <http://www.w3.org/ns/auth/acl#Authorization>;\n  <http://www.w3.org/ns/auth/acl#accessTo> <${CONTAINER}>;\n  <http://www.w3.org/ns/auth/acl#agentClass> <http://xmlns.com/foaf/0.1/Agent>;\n  <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read>.`,
    );
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(null, { status: 405 });
      }
      return ttlResponse(withPublic);
    });
    await expect(
      establishContainerAcl(
        fetchImpl as unknown as typeof fetch,
        CONTAINER,
        WEBID,
      ),
    ).rejects.toThrow(/could not establish an owner-only ACL/);
  });

  it("405 + an existing .acl MISSING acl:default owner coverage FAILS CLOSED", async () => {
    // accessTo owner coverage only — the create→acl window relies on default; reject.
    const accessToOnly = await ownerOnlyResourceAcl(CONTAINER, WEBID);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(null, { status: 405 });
      }
      return ttlResponse(accessToOnly);
    });
    await expect(
      establishContainerAcl(
        fetchImpl as unknown as typeof fetch,
        CONTAINER,
        WEBID,
      ),
    ).rejects.toThrow(/could not establish an owner-only ACL/);
  });
});

describe("containerIsAlreadyOwnerPrivate (positive proof)", () => {
  it("returns true for a complete owner-only accessTo+default .acl", async () => {
    const existing = await ownerOnlyContainerAcl(CONTAINER, WEBID);
    const fetchImpl = vi.fn(async () => ttlResponse(existing));
    expect(
      await containerIsAlreadyOwnerPrivate(
        fetchImpl as unknown as typeof fetch,
        `${CONTAINER}.acl`,
        CONTAINER,
        WEBID,
      ),
    ).toBe(true);
  });

  it("returns false when the .acl cannot be fetched (fail closed)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    expect(
      await containerIsAlreadyOwnerPrivate(
        fetchImpl as unknown as typeof fetch,
        `${CONTAINER}.acl`,
        CONTAINER,
        WEBID,
      ),
    ).toBe(false);
  });

  it("accepts accessTo + default split across two owner-only authorizations", async () => {
    const ns = "http://www.w3.org/ns/auth/acl#";
    const split =
      `<#a> a <${ns}Authorization>; <${ns}accessTo> <${CONTAINER}>; <${ns}agent> <${WEBID}>;` +
      ` <${ns}mode> <${ns}Read>, <${ns}Write>, <${ns}Control>.\n` +
      `<#d> a <${ns}Authorization>; <${ns}default> <${CONTAINER}>; <${ns}agent> <${WEBID}>;` +
      ` <${ns}mode> <${ns}Read>, <${ns}Write>, <${ns}Control>.`;
    const fetchImpl = vi.fn(async () => ttlResponse(split));
    expect(
      await containerIsAlreadyOwnerPrivate(
        fetchImpl as unknown as typeof fetch,
        `${CONTAINER}.acl`,
        CONTAINER,
        WEBID,
      ),
    ).toBe(true);
  });
});

describe("putResourceAcl (fail-closed)", () => {
  it("PUTs the resource .acl and resolves on 2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    await putResourceAcl(fetchImpl as unknown as typeof fetch, RESOURCE, WEBID);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${RESOURCE}.acl`);
    expect(init.method).toBe("PUT");
  });

  it("accepts a 405 (no writable per-resource .acl; inherited container default secures it)", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 405 }));
    await expect(
      putResourceAcl(fetchImpl as unknown as typeof fetch, RESOURCE, WEBID),
    ).resolves.toBeUndefined();
  });

  it("THROWS on a 403 — never swallows a 4xx (would leave data unprotected)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 403, statusText: "Forbidden" }),
    );
    await expect(
      putResourceAcl(fetchImpl as unknown as typeof fetch, RESOURCE, WEBID),
    ).rejects.toThrow(/without its owner-only ACL/);
  });
});
