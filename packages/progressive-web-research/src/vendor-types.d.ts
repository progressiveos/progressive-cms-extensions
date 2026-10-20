// turndown-plugin-gfm ships no type declarations — minimal surface we use.
declare module "turndown-plugin-gfm" {
  export const gfm: (service: import("turndown").default) => void;
  export const tables: (service: import("turndown").default) => void;
  export const strikethrough: (service: import("turndown").default) => void;
  export const taskListItems: (service: import("turndown").default) => void;
}
