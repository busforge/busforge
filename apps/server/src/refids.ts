// A com-object parameter ref exists in two shapes: the FULL id the config view uses
// (`${appId}_${key}`) and the STORED key the DB uses (app prefix stripped). Branded
// aliases + these two helpers are the only sanctioned conversions; hand-rolled
// slice/startsWith copies are the bug class this replaces (a silent lookup miss).
export type FullRefId = string & { readonly __brand?: "FullRefId" };
export type StoredRefKey = string & { readonly __brand?: "StoredRefKey" };
export const fullRef = (appId: string, key: string): FullRefId => `${appId}_${key}`;
export const stripRef = (appId: string, id: string): StoredRefKey => (id.startsWith(`${appId}_`) ? id.slice(appId.length + 1) : id);
