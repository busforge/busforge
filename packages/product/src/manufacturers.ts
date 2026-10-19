// Where each manufacturer publishes its ETS product data, keyed by KNX manufacturer id. A link
// leads to the manufacturer's own download page; Busforge never downloads or ships the databases,
// the user imports the file. `productDataUrl: null` means no public page was found (data only
// through the ETS Online Catalog, or behind a partner login). Names follow the KNX manufacturer
// list. Only pages that were opened and offer the data are listed.

export interface ManufacturerInfo { id: string; name: string; productDataUrl: string | null }

const TABLE: ManufacturerInfo[] = [
  { id: "M-0002", name: "ABB", productDataUrl: null },
  { id: "M-0004", name: "Albrecht Jung", productDataUrl: "https://www.jung-group.com/de-DE/downloads/product-downloads/" },
  { id: "M-0008", name: "Gira Giersiepen", productDataUrl: "https://partner.gira.com/en/service/download/index.html?type=L&id=3154&lang=en" },
  { id: "M-0048", name: "Theben", productDataUrl: "https://www.theben.de/downloads" },
  { id: "M-0081", name: "Basalte", productDataUrl: null },
  { id: "M-0083", name: "MDT technologies", productDataUrl: "https://www.mdt.us/for-professionals/downloads/ets-product-data.html" },
  { id: "M-0085", name: "GVS", productDataUrl: "https://gvssmart.de/downloads/" },
  { id: "M-008E", name: "Steinel", productDataUrl: null },
  { id: "M-00FA", name: "KNX Association (OpenKNX)", productDataUrl: null },
  { id: "M-0162", name: "MEAN WELL", productDataUrl: "https://www.meanwell.eu/productSoftware.aspx" },
];

export const MANUFACTURERS: readonly ManufacturerInfo[] = TABLE;

// 0x83 -> "M-0083", the id form the catalog and the evidence records use.
export const manufacturerId = (n: number) => `M-${n.toString(16).toUpperCase().padStart(4, "0")}`;

export const manufacturerInfo = (id: string): ManufacturerInfo | undefined => TABLE.find((m) => m.id === id);
