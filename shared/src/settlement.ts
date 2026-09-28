// Hasad Gold weight-difference settlement — the single source of truth for the rule,
// used by the backend (authoritative) and the frontend (live preview).
//
// Rule (from the business requirements):
//   delivered < entitled  -> the BRANCH pays the customer the value of the difference
//   delivered > entitled  -> the CUSTOMER pays the branch the value of the difference
//   equal                 -> nothing to settle

import type { SettlementDirection } from './enums';
import { sumInt, valueOfWeight } from './money';
import { pureGoldMg } from './units';

export type SettlementBasis = 'NET_WEIGHT' | 'PURE_GOLD_EQUIVALENT';

export interface SettlementItemInput {
  netWeightMg: number;
  karat: number;
}

export interface SettlementInput {
  entitledWeightMg: number;
  /** Karat the Hasad entitlement is denominated in (only used for PURE_GOLD_EQUIVALENT). */
  entitlementKarat: number;
  items: SettlementItemInput[];
  /** SDG per gram used to value the difference. */
  ratePerGram: number;
  basis: SettlementBasis;
}

export interface SettlementResult {
  entitledWeightMg: number;
  deliveredWeightMg: number;
  /** delivered − entitled, in the comparison basis (signed). */
  differenceMg: number;
  /** |difference| */
  absDifferenceMg: number;
  direction: SettlementDirection;
  ratePerGram: number;
  /** Always positive; who pays is given by `direction`. */
  amount: number;
  basis: SettlementBasis;
}

export function calculateSettlement(input: SettlementInput): SettlementResult {
  const { entitledWeightMg, entitlementKarat, items, ratePerGram, basis } = input;

  let entitled = entitledWeightMg;
  let delivered = sumInt(items.map((i) => i.netWeightMg));

  if (basis === 'PURE_GOLD_EQUIVALENT') {
    entitled = pureGoldMg(entitledWeightMg, entitlementKarat);
    delivered = sumInt(items.map((i) => pureGoldMg(i.netWeightMg, i.karat)));
  }

  const differenceMg = delivered - entitled;
  const absDifferenceMg = Math.abs(differenceMg);
  const direction: SettlementDirection =
    differenceMg < 0 ? 'BRANCH_PAYS_CUSTOMER' : differenceMg > 0 ? 'CUSTOMER_PAYS_BRANCH' : 'NONE';
  // Exact integer arithmetic (L-7): round(|Δmg| × rate / 1000), no float intermediate.
  const amount = valueOfWeight(absDifferenceMg, ratePerGram);

  return {
    entitledWeightMg: entitled,
    deliveredWeightMg: delivered,
    differenceMg,
    absDifferenceMg,
    direction,
    ratePerGram,
    amount,
    basis,
  };
}
