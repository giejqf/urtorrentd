# ADR 0003: A typed schema generated from the code

Status: accepted (2026-09-22)

## Context

The maintainer wants an auto-generated typed API schema so frontends get an
SDK from a generator with end-to-end type safety. A hand-written schema
drifts; a generated one drifts too unless the generation is tied to the
router and checked against real responses.

## Decision

- **utoipa 5 + utoipa-axum** generate OpenAPI 3.1 from `#[utoipa::path]`
  annotations and `ToSchema` types. Routes are registered through
  `utoipa_axum::routes!`, so the router and the document come from the same
  list: a handler cannot be routed without being documented, and paths and
  methods cannot disagree. (`aide`, which infers more from handler
  signatures, was considered; its stable line is a year old and 0.16 has
  been in alpha since late 2025. utoipa is the mainstream choice.)
- Request bodies are inferred from the handlers' `Json<T>` extractor (our
  own `api::Json`, which also turns rejections into the API's error shape);
  query and path parameters are declared with `IntoParams` types; success
  responses are declared per handler; every error response is added to every
  operation by a modifier, all with `ErrorBody`.
- **Checks that keep it honest** (all in `cargo test`):
  - every response in the integration tests is validated against the
    documented schema for its status (`tests/common`), and a request to an
    undocumented endpoint fails the test;
  - the committed `openapi.json` equals the generated one
    (`tests/openapi.rs`; `cargo xtask openapi` regenerates it);
  - every `$ref` resolves, operation ids are unique, each operation has one
    success response and typed errors.
  - `cargo xtask sdk` generates TypeScript types with openapi-typescript
    and type-checks a client (`sdk/typescript/check.ts`), including
    `@ts-expect-error` lines that prove wrong calls do not compile.
- **Schema rules** found on the way:
  - Types used in requests put `#[serde(default)]` on fields, never on the
    container: a container default makes utoipa emit `default` values, which
    openapi-typescript turns into required properties.
  - `Option` fields of response types that are always sent carry
    `#[schema(required = true)]` (present, possibly `null`).
  - Schemas referenced only from query parameters must be listed in
    `ApiDoc`'s `components(schemas(...))` (the `$ref` check catches it).

## Consequences

The schema is served at `GET /api/v1/openapi.json` (public) and committed at
the repository root for SDK generation in CI. Adding an endpoint means an
annotation, a `routes!` entry, a line in `docs/api.md`, a test that calls it,
and a regenerated `openapi.json`.
