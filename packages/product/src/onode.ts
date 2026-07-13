// fast-xml-parser's `preserveOrder` shape, in one place.
//
// In that mode a node is an object with exactly two possible keys: the element's TAG (holding its
// children as an array) and ":@" (holding its attributes). The key set is the document's, not ours,
// so the values are `unknown` and these three accessors are the only places that state what each
// one is. Order matters to us — an application's <Dynamic> tree is a document, not a bag — which is
// why this shape is used at all instead of the plain object model.
//
// Both readers of application XML (loadproc.ts and appconfig.ts) had their own copy of this. They
// are in the same package, and a second copy of a contract this subtle is a second place for it to
// drift.
export type ONode = Record<string, unknown>;

export const tagOf = (n: ONode): string => Object.keys(n).find((k) => k !== ":@")!;

export const attrsOf = (n: ONode): Record<string, string> => (n[":@"] as Record<string, string> | undefined) ?? {};

export const kidsOf = (n: ONode): ONode[] => { const v = n[tagOf(n)]; return Array.isArray(v) ? (v as ONode[]) : []; };

export const childrenByTag = (nodes: ONode[], tag: string): ONode[] => nodes.filter((n) => tagOf(n) === tag);

export const firstByTag = (nodes: ONode[], tag: string): ONode | undefined => nodes.find((n) => tagOf(n) === tag);
