// The device list's URL state: what narrows the list (q, changed) and the building shown (b).
export type DeviceListSearch = { q?: string; changed?: boolean; b?: string };

// A filter is on when it narrows the list; a search of only spaces narrows nothing.
export const isFiltering = (s: DeviceListSearch) => !!s.q?.trim() || !!s.changed;

// Clears what narrows the list; the building shown is a place, not a filter, and stays.
export const withoutFilters = (s: DeviceListSearch): DeviceListSearch => ({ ...s, q: undefined, changed: undefined });
