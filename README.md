# progressive-cms-extensions

First-party extension packages for Progressive CMS (ADR-0017): small,
individually versioned trusted packages consumed by the platform at
**build time** through `extensions/first-party.lock.json` (exact version +
content sha256). No runtime loading, no marketplace — trusted code, static
composition (Extensions spec §52).

## Layout

- `packages/<name>/` — one package per directory: `manifest.json` (extension
  manifest v2) + `src/` (+ `migrations/` when the package owns tables).
- `dist/` — packed tarballs (`gitignore`d), produced from immutable tags.

## Release a package

```sh
git commit -am "progressive-media-unsplash: ..."   # the package change
git tag progressive-media-unsplash-v1.0.0          # exact package version from its manifest
./pack.sh progressive-media-unsplash-v1.0.0        # → dist/progressive-media-unsplash-1.0.0.tar.gz (+ .sha256)
```

The Core repository's lock references the tarball (`source.tarball` +
`source.sha256` — supply identity) and the package's content digest
(`content_sha256` — artifact identity, ADR-0017 R2). `scripts/
compose-first-party.mjs check` verifies both before anything is composed.
The archives are reproducible from identical tagged files across independent Git
histories: file order, ownership, timestamps and gzip metadata are normalized.
No Registry credentials or private repository is required to build these packages.

## Package contract

Import only public platform exports (`@pcms/extensions`, `@pcms/media`,
types of `@pcms/core`). Handlers referenced by manifest registrations must be
exports of `src/index.ts` — or the manifest declares `entrypoint.factory`
for a pool-bound module. Permissions outside the platform registry require
`permission_namespace` (ADR-0017 R1).

## License

First-party packages and examples are Apache-2.0. See LICENSE, NOTICE and
THIRD_PARTY_NOTICES.md. Progressive Shop and the Registry/Cloud control plane
are not part of this repository. Third-party extensions may use their own licenses.

Run the packaging regression with `node --test tests/pack.test.mjs`.
