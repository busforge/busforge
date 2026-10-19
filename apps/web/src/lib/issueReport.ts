import { orderOf } from "./untested.ts";

// A prefilled GitHub issue (docs/reporting.md): the app builds a link to the repository's issue
// form and the user reviews and submits it there with their own account. Busforge holds no GitHub
// token and posts nothing. Only the fields below ever enter the link: the Busforge version, the
// Product and the application program. Never the device's name, its address, room names, keys or
// anything read from the bus. Not the catalogue's product text either: for a project imported
// before the catalogue existed it is the user's own name of a device (db/catalog.ts backfill).

export const ISSUE_REPOSITORY = "https://github.com/busforge/busforge";

// GitHub answers 414 URI Too Long above its server limit (about 8 KiB); this stays well below it.
// Above it the description leaves the link and the user copies it into the form by hand.
export const MAX_ISSUE_URL = 6000;

// The longest a metadata value may be once URL-encoded; manufacturer names, order numbers and KNX
// ids are far shorter. Title, version and product hold at most two such values each.
const MAX_VALUE = 600;

type Withheld = "productRef" | "appProgramId" | "commit" | "version" | "manufacturer" | "orderNumber";

export type ReportKind = "problem" | "feedback";

// The template file and the ids of its fields (.github/ISSUE_TEMPLATE/). issueReport.test.ts holds
// these against the templates themselves.
export const REPORT_TEMPLATES = {
  problem: { file: "problem.yml", titlePrefix: "Problem", description: "what" },
  feedback: { file: "device-feedback.yml", titlePrefix: "Device feedback", description: "use" },
} as const satisfies Record<ReportKind, { file: string; titlePrefix: string; description: string }>;

// The metadata fields a link may carry, the same ids in both templates.
export const METADATA_FIELDS = ["version", "product", "application"] as const;
export type MetadataField = typeof METADATA_FIELDS[number];

export interface ReportSubject {
  manufacturerId: string; // "M-0083"
  manufacturerName?: string; // from the build's manufacturer table
  orderNumber: string;
  productRef: string;
  appProgramId: string;
}

// The device fields a report is built from. Device names, addresses and rooms are not among them.
export type ReportDevice = { productRef: string; appRef: string; manufacturer: number };

// "M-0083_H-…_HP-00B6-32-9642" -> "M-0083_A-00B6-32-9642", as @busforge/project's appProgramId.
export const appProgramIdOf = (appRef: string) => {
  const hp = appRef.split("_HP-")[1];
  return hp ? `${appRef.split("_")[0]}_A-${hp}` : appRef;
};

// What a report says about a device. From the catalogue only the order number, and only when the
// catalogue has one: the backfill of db/catalog.ts writes the user's device name as product text and
// leaves the order number empty, so a backfilled row contributes nothing.
export function subjectOf(
  device: ReportDevice,
  catalog: readonly { productRef: string; appRef: string; orderNumber: string }[] | undefined,
  manufacturers: readonly { id: string; name: string }[] | undefined,
): ReportSubject {
  const product = catalog?.find((p) => p.productRef === device.productRef && p.appRef === device.appRef);
  const mid = `M-${device.manufacturer.toString(16).toUpperCase().padStart(4, "0")}`;
  return {
    manufacturerId: mid,
    manufacturerName: manufacturers?.find((m) => m.id === mid)?.name,
    orderNumber: product?.orderNumber || orderOf(device.productRef),
    productRef: device.productRef,
    appProgramId: appProgramIdOf(device.appRef),
  };
}

export interface ReportInput {
  kind: ReportKind;
  version: { version: string; commit: string };
  subject?: ReportSubject;
  description?: string;
}

export interface IssueDraft {
  url: string;
  title: string;
  // What the link fills in, in form order, exactly as GitHub shows it.
  fields: { id: MetadataField; value: string }[];
  // Values left out: not a KNX id or commit, or too long for the link.
  withheld: Withheld[];
  description: string;
  // False when the description would make the link too long: it is then not in the link at all.
  descriptionInUrl: boolean;
  // Issues, open or closed, that name the same application program, to relate a report to earlier ones.
  searchUrl: string | null;
}

// Control characters, and the bidirectional overrides that make text read differently than it is.
// oxlint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

// One line of metadata: no control characters, whitespace collapsed.
export const cleanValue = (s: string) => s.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
// The user's own text keeps its line breaks (a lone CR becomes one) and tabs.
export const cleanText = (s: string) => s.replace(/\r\n?/g, "\n").replace(UNSAFE, "").trim();
// Bounded by its encoded length, so title and three fields always fit below MAX_ISSUE_URL.
const fits = (s: string) => new URLSearchParams({ v: s }).toString().length - 2 <= MAX_VALUE;

// KNX catalogue ids ("M-0083_A-00B6-32-9642"); anything else is not put into a public link.
const KNX_ID = /^M-[0-9A-F]{4}_[A-Za-z0-9._-]{1,200}$/;
const MANUFACTURER_ID = /^M-[0-9A-F]{4}$/;
const COMMIT =/^[0-9a-f]{7,40}$/;

export function buildIssueDraft(input: ReportInput): IssueDraft {
  const template = REPORT_TEMPLATES[input.kind];
  const withheld: IssueDraft["withheld"] = [];

  // A value too long for the link is left out whole, never cut short.
  const bounded = (value: string, name: Withheld) => (fits(value) ? value : (withheld.push(name), ""));

  const commit = input.version.commit;
  const commitOk = COMMIT.test(commit);
  if (!commitOk && commit !== "unknown") withheld.push("commit");
  const version = bounded(cleanValue(input.version.version), "version");
  const versionText = version && commitOk && !version.includes(commit) ? `${version} (${commit})` : version;
  const fields: IssueDraft["fields"] = versionText ? [{ id: "version", value: versionText }] : [];

  let head = "";
  let searchUrl: string | null = null;
  const s = input.subject;
  if (s) {
    const maker = bounded(cleanValue(s.manufacturerName ?? ""), "manufacturer") || (MANUFACTURER_ID.test(s.manufacturerId) ? s.manufacturerId : "");
    const order = bounded(cleanValue(s.orderNumber), "orderNumber");
    const productRef = KNX_ID.test(s.productRef) ? s.productRef : (withheld.push("productRef"), "");
    const appId = KNX_ID.test(s.appProgramId) ? s.appProgramId : (withheld.push("appProgramId"), "");
    head = [maker, order].filter(Boolean).join(" ");
    const product = [head, productRef].filter(Boolean).join(" · ");
    if (product) fields.push({ id: "product", value: product });
    if (appId) fields.push({ id: "application", value: appId });
    if (appId) searchUrl = `${ISSUE_REPOSITORY}/issues?${new URLSearchParams({ q: `is:issue "${appId}"` }).toString()}`;
  }

  // Without a product the title ends in a space, for the user to go on typing.
  const title = head ? `${template.titlePrefix}: ${head}` : `${template.titlePrefix}: `;
  const description = cleanText(input.description ?? "");
  const link = (withDescription: boolean) => {
    const q = new URLSearchParams({ template: template.file, title });
    for (const f of fields) q.set(f.id, f.value);
    if (withDescription && description) q.set(template.description, description);
    return `${ISSUE_REPOSITORY}/issues/new?${q.toString()}`;
  };
  const full = link(true);
  const descriptionInUrl = full.length <= MAX_ISSUE_URL;
  return { url: descriptionInUrl ? full : link(false), title, fields, withheld, description, descriptionInUrl, searchUrl };
}
