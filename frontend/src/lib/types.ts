// View models returned by the API (kept close to the backend service shapes).

export interface Branch {
  id: number;
  code: string;
  name: string;
  nameAr: string;
  city: string;
  address?: string | null;
  phone?: string | null;
  isActive?: boolean;
}

export interface ItemRow {
  id: number;
  code: string;
  barcode: string;
  productId: number;
  productName: string | null;
  productNameAr: string;
  sku: string;
  categoryCode: string;
  categoryName: string | null;
  categoryNameAr: string;
  karat: number;
  grossWeightMg: number;
  netWeightMg: number;
  purchaseCost?: number;
  makingCost?: number;
  otherCost?: number;
  totalCost?: number;
  sellingPrice: number;
  /** OPENING, SUPPLIER_NEW (new from a supplier) or SCRAP (sellable piece bought from a customer). */
  origin: 'OPENING' | 'SUPPLIER_NEW' | 'SCRAP';
  branchId: number;
  branchCode: string;
  branchName: string;
  branchNameAr: string;
  status: string;
  reservationRef: string | null;
  reservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An item type (table `categories`). The English name is optional (CAT-0): show it with L(name, nameAr). */
export interface Category {
  id: number;
  code: string;
  name: string | null;
  nameAr: string;
  isActive: boolean;
}

/** A product (sellable design) with its type. */
export interface Product {
  id: number;
  sku: string;
  name: string | null;
  nameAr: string;
  karat: number;
  categoryId: number;
  categoryCode: string;
  categoryName: string | null;
  categoryNameAr: string;
  isActive: boolean;
}

export interface Supplier {
  id: number;
  name: string | null;
  nameAr: string;
  phone: string | null;
}

export interface Report {
  key: string;
  title: string;
  description: string;
  columns: { key: string; label: string; type: string; link?: string }[];
  rows: Record<string, unknown>[];
  totals?: Record<string, number>;
  notes?: string[];
  /** Headline figures above the table (e.g. stock weight incl. broken scrap). */
  summary?: { label: string; type: string; value: number }[];
  filters: { dateRange: boolean; branch: boolean; user: boolean; status?: string[] };
}
