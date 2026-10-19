// A com-object's group addresses as the device page edits them, in order: the first is the address
// the object sends on (and answers reads on), the others it listens to. Each edit returns the whole
// new list, which the page sends as the object's links.

export const replaceOnly = (raw: number | null): number[] => (raw == null ? [] : [raw]);
export const addLink = (list: number[], raw: number): number[] => (list.includes(raw) ? list : [...list, raw]);
export const removeLink = (list: number[], raw: number): number[] => list.filter((g) => g !== raw);
export const makeSender = (list: number[], raw: number): number[] => [raw, ...list.filter((g) => g !== raw)];
export const addedLinks = (before: number[], after: number[]): number[] => after.filter((g) => !before.includes(g));
