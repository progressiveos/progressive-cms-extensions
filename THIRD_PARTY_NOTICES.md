# Third-party components

The Apache-2.0 grant applies to Progressive OS Ltd.'s first-party materials.
Dependencies and bundled third-party assets retain their original licenses,
copyright statements and notices. Their license files must accompany redistribution.
The exact dependency versions are recorded in package-lock.json and, for
first-party packages with their own dependencies, their package-lock.json files.

## Bundled Admin assets

- Manrope: Copyright 2018 The Manrope Project Authors, SIL Open Font License 1.1.
  The complete license is retained at apps/admin/public/fonts/manrope/LICENSE.txt
  and in the installed Admin assets.
- Font Awesome Free: copyright Fonticons, Inc. The upstream license distinguishes
  icons (CC BY 4.0), fonts (SIL OFL 1.1) and code (MIT). The complete upstream
  notices are retained at apps/admin/public/vendor/fontawesome/LICENSE.txt and
  with the installed assets. These materials are not relicensed as Apache-2.0.

## JavaScript and native dependencies

The runtime ZIP contains dependency packages and their upstream license/notice
files in node_modules, including extension-local node_modules. Do not remove
those notices when redistributing. React, Tiptap OSS/ProseMirror, Fastify,
LiquidJS and other dependencies remain under their respective upstream licenses.
No proprietary Tiptap editor features are included.

Sharp is Apache-2.0. Its separately distributed, replaceable libvips binaries
and bundled libraries include LGPL and other licenses; they are not first-party
Apache-2.0 code. The @img/sharp-libvips-*/README.md and versions.json files
identify the included libraries and versions. Preserve them, their license files,
and users' ability to replace/rebuild these libraries.

The upstream build scripts and corresponding-source instructions are maintained
at https://github.com/lovell/sharp-libvips and
https://sharp.pixelplumbing.com/install/#licensing . A distributor of the native
binaries must also fulfil the applicable corresponding-source obligations; the
package license allowlist alone is not evidence that these obligations are met.
