// Server-safe entry (no React): detection, parsing and the data model. The React
// view is a separate export ("./view") so the server can import this without
// pulling in React.
export { MODULE_ID, matchesApp, evaluate, manifest, BAGGAGE_TOKEN, type DcaManifest, type MatchResult } from "./match.ts";
export { parseDaliStore } from "./parse.ts";
export * from "./model.ts";
