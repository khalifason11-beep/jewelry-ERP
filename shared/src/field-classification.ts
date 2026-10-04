// Cost visibility (decision Q15, docs/decisions.md D-2a-7): cost, acquisition cost and profit are
// General-Manager-only. This registry classifies EVERY database column and EVERY API response
// field as COST or SAFE. It drives the server's response filter (backend/src/core/cost-redaction.ts),
// and tests fail the build when
//   * a database column is not classified (test walks the Drizzle schema), or
//   * any API response contains a field name that is not classified, or
//   * a COST field reaches a caller without `profit.view` (every GET route, BM and cashier).

export type FieldClass = 'COST' | 'SAFE';

/** A table's columns (SQL names): the COST ones and the SAFE ones; together they must list every column. */
interface TableClasses {
  cost?: readonly string[];
  safe: readonly string[];
  /** Phase 2fa: never sent to anyone, in any response (hashes, private material, public keys). */
  secret?: readonly string[];
}

const words = (s: string) => s.trim().split(/\s+/);

export const COLUMN_CLASSES: Record<string, TableClasses> = {
  // ── ERP schema (database/src/schema.ts)
  audit_logs: {
    // description / description_params / metadata may *mention* amounts: audit rows are redacted at
    // read time for callers without profit.view (cost-named params hidden, description re-rendered).
    safe: words('id at user_id username user_full_name role branch_id action entity_type entity_id description description_key description_params metadata session_id ip_address'),
  },
  branches: { safe: words('id code name name_ar city address phone hasad_branch_code is_active created_at') },
  branding_assets: { safe: words('id kind mime bytes sha256 size width height uploaded_by uploaded_at') },
  categories: { safe: words('id code name name_ar') },
  document_sequences: { safe: words('scope next') },
  expenses: { safe: words('id number branch_id category amount expense_date description status created_by created_at reviewed_by reviewed_at review_note paid_from') },
  gold_rates: { safe: words('id karat price_per_gram effective_at set_by') },
  hasad_redemption_items: { cost: ['unit_cost'], safe: words('id redemption_id item_id net_weight_mg karat active added_at released_at') },
  hasad_redemptions: {
    cost: ['items_cost'],
    safe: words('id number withdrawal_id branch_id cashier_id status entitled_weight_mg delivered_weight_mg difference_mg settlement_direction settlement_amount rate_per_gram customer_verified created_at completed_at aborted_at abort_reason'),
  },
  hasad_withdrawals: {
    safe: words(
      'id external_id hasad_customer_id customer_name customer_name_ar customer_phone customer_national_id_masked entitled_weight_mg entitlement_karat branch_id status external_status pickup_code requested_at received_at opened_at opened_by completed_at completed_by cancelled_at cancelled_by cancel_reason last_synced_at',
    ),
  },
  // Stored responses are replayed only to the user who made the request, already filtered for them;
  // a GM's stored response can hold cost figures, hence COST.
  idempotency_keys: { cost: ['response_body'], safe: words('id user_id key route request_hash status response_status created_at completed_at') },
  inventory_movements: { cost: ['cost_value'], safe: words('id item_id branch_id type direction from_branch_id to_branch_id ref_type ref_id ref_number net_weight_mg user_id note at') },
  item_status_history: { safe: words('id item_id from_status to_status branch_id ref_type ref_id ref_number user_id note at') },
  jewelry_items: {
    // Phase 2b cost model: acquisition cost, the making charge inside it, and whether it is an estimate.
    cost: words('purchase_cost making_cost other_cost total_cost acquisition_cost making_charge cost_is_estimated'),
    safe: words('id code barcode product_id karat gross_weight_mg net_weight_mg selling_price branch_id status purchase_id reservation_ref reserved_at reserved_by created_at updated_at origin supplier_id supplier_invoice_ref'),
  },
  permissions: { safe: words('code description') },
  products: { safe: words('id sku name name_ar category_id karat description created_at') },
  purchase_items: { cost: words('purchase_cost making_cost other_cost'), safe: words('id purchase_id item_id') },
  // Phase 4: MONEY costs of a supplier order (total cost, making charge paid) are GM-only.
  purchases: {
    cost: words('total_cost making_charge_paid'),
    // The order's GOLD weights are SAFE (client decisions D-4-13, D-4-16): gold_debt_mg_pure24 (owed
    // before settlements) and gold_owed_mg_pure24 (still owed) are OPERATIONAL quantities the branch
    // manager settles against. They reveal neither what the shop paid nor what it earned, and the debt
    // is derivable anyway from the visible piece weights and karats.
    safe: words('id number branch_id supplier_id supplier_invoice_no status item_count total_net_weight_mg notes created_by created_at making_charge_paid_from gold_owed_mg_pure24 gold_debt_mg_pure24'),
  },
  role_permissions: { safe: words('role_id permission_code') },
  roles: { safe: words('id code name name_ar description is_system rank') },
  // Price components (price_*) describe the SELLING price (Q2), not the cost: SAFE.
  sale_items: {
    cost: words('unit_cost acquisition_cost profit'),
    safe: words('id sale_id item_id product_name karat net_weight_mg list_price discount final_price pricing_mode price_gold_value price_making_charge price_rate_per_gram'),
  },
  sales: {
    cost: ['cost_total'],
    safe: words('id number branch_id cashier_id session_id customer_name customer_name_ar customer_phone subtotal discount_total total payment_method status voided_at voided_by void_reason created_at payment_ref_invoice payment_ref_transaction'),
  },
  sessions: {
    safe: words('id user_id branch_id login_at last_activity_at user_agent device ip_address current_module status ended_at ended_reason absolute_expires_at reauth_at csrf_token is_simulated sign_in_method passkey_reauth_at passkey_reauth_uv'),
  },
  settings: { safe: words('key value version updated_at updated_by') },
  settings_history: { safe: words('id key old_value new_value version actor_id actor_username reason at') },
  settlements: { safe: words('id number type redemption_id branch_id direction weight_mg rate_per_gram amount payment_method confirmed_by confirmed_at') },
  suppliers: { safe: words('id name name_ar phone') },
  transfer_items: { safe: words('transfer_id item_id') },
  transfers: { safe: words('id number from_branch_id to_branch_id status notes created_by created_at received_by received_at') },
  users: {
    safe: words('id username full_name full_name_ar role_id branch_id must_change_password password_changed_at status phone last_login_at failed_login_count locked_until created_at created_by mfa_failed_count mfa_locked_until recovery_codes_generated_at recovery_codes_acknowledged_at security_locked_at security_lock_reason'),
    secret: words('password_hash webauthn_user_handle'),
  },
  // ── Second factor (Phase 2fa): ids, nicknames, dates and flags are SAFE; keys, hashes and challenges are SECRET.
  webauthn_credentials: {
    safe: words('id user_id credential_id sign_count transports nickname device_type backed_up uv_at_registration created_at last_used_at revoked_at revoked_reason'),
    secret: words('public_key'),
  },
  webauthn_challenges: { safe: words('id purpose user_id session_id pending_id rp_id origin nickname created_at expires_at consumed_at'), secret: words('challenge_hash') },
  login_pending: { safe: words('user_id ip_address user_agent created_at expires_at consumed_at'), secret: words('token_hash') },
  recovery_codes: { safe: words('id user_id generated_at used_at invalidated_at'), secret: words('code_hash') },
  sign_in_events: { safe: words('id user_id session_id method credential_id credential_nickname browser ip_approx uv new_device at dismissed_at') },
  // ── Branch money ledger (Phase 2b): money flows of the branch, visible to its manager.
  ledger_accounts: { safe: words('id branch_id kind created_at') },
  ledger_entries: { safe: words('id account_id branch_id amount event_type payment_method ref_type ref_id ref_number reverses_entry_id actor_id session_id idempotency_key note at') },
  cash_counts: { safe: words('id branch_id business_day counted_amount expected_amount counted_by note at') },
  // ── Scrap gold (Phase 4). The pool, rates and counter purchases are branch operations (like the ledger).
  scrap_rates: { safe: words('id karat price_per_gram effective_at set_by') },
  scrap_purchases: {
    safe: words(
      'id number branch_id kind karat gross_weight_mg net_weight_mg scrap_rate_per_gram agreed_rate_per_gram deviation_bp override_approved amount payment_method item_id customer_name customer_phone customer_id_ref note created_by created_at',
    ),
  },
  scrap_weight_entries: { safe: words('id branch_id karat weight_mg event_type ref_type ref_id ref_number actor_id session_id idempotency_key note at') },
  // Settlement weights are SAFE (D-4-16): the branch manager hands the scrap over and records it himself.
  supplier_settlements: {
    safe: words('id number purchase_id branch_id actor_id session_id idempotency_key note at settled_karat settled_weight_mg settled_pure_mg24'),
  },
  // Phase 2c: backup / restore-drill runs (no secrets are ever stored: file name, size, checksum, summary).
  backup_runs: { safe: words('id kind status file_name size_bytes sha256 encrypted uploaded detail host started_at finished_at') },
  // Hasad bank transfers received (Phase 4 follow-up): a money movement between two branch accounts, like the ledger.
  hasad_receivable_settlements: { safe: words('id number branch_id amount bank_reference note actor_id session_id idempotency_key at') },
  // ── Hasad mock schema (integrations/hasad/src/mock/schema.ts, demo only)
  api_calls: { safe: words('id at operation request response_status response duration_ms') },
  customers: { safe: words('id full_name full_name_ar phone national_id_masked balance_mg karat created_at') },
  withdrawals: { safe: words('id customer_id weight_mg karat branch_code status pickup_code requested_at updated_at completion cancellation') },
};

/** Response field names that carry cost, acquisition cost, margin or profit. */
export const COST_RESPONSE_FIELDS: ReadonlySet<string> = new Set([
  'cost',
  'costs',
  'unitCost',
  'costTotal',
  'costValue',
  'costOfSales',
  'totalCost',
  'purchaseCost',
  'makingCost',
  'otherCost',
  'itemsCost',
  'hasadItemsCost',
  'inventoryCost',
  'purchasesCost',
  'acquisitionCost',
  'grossProfit',
  'profit',
  'margin',
  'contribution',
  'responseBody',
  'acquisitionCost',
  'makingCharge',
  'costIsEstimated',
  'makingChargePaid',
]);

/** Every other field name the API sends, classified SAFE (one registry; unknown names fail tests). */
export const SAFE_RESPONSE_FIELDS: ReadonlySet<string> = new Set(
  words(`
    abortReason abortedAt absDifferenceMg action actions active activeSessions actual address addedAt allowSelfPasswordChange
    allowedKarats alreadyOpen amount appMode approvalThreshold ar asOf at attention availableItems availableWeightMg
    balanceGrams barcode basis branch branchAddress branchCode branchId branchName branchNameAr branchPhone branches branding
    byCategory cancelReason cancelled cancelledAt cancelledBy cashierId cashierName cashierNameAr cashierUsername cashiers
    category categoryCode categoryId categoryName categoryNameAr city closing closingItems closingWeightMg code codes
    collectedFromCustomers columns company completed completedAt completedBy completedByName completedToday concurrentSessions
    confirmedAt confirmedBy count createdAt createdBy createdByName csrfToken currency currencyCode currencyLabelAr
    currencyLabelEn current currentModule customer customerId customerName customerNameAr customerNationalIdMasked
    customerPhone customerVerified damaged date dateRange day delivered deliveredWeightMg demoAccounts description
    descriptionKey descriptionParams device differenceMg direction discount discountTotal discounts draft driver durationMs
    effectiveAt en enabledPerBranch endedAt endedReason entitled entitledWeightMg entitlementKarat entityId entityType enum
    error expenseDate expenses externalId externalStatus failedLoginCount failedLogins filters finalPrice firstLogin from
    fromBranchId fromBranchName fromStatus fullName fullNameAr goldRateScope grossWeightMg hasPickupCode hasad
    hasadBranchCode hasadCancelled hasadCollectedFromCustomers hasadCompleted hasadCount hasadCustomerId hasadInProgress
    hasadMode hasadOpen hasadPaidToCustomers hasadReceived hasadWeightMg history hour hourly id idleMinutes inProgress
    inventory inventoryByKarat inventoryRetail invoiceFooterAr invoiceFooterEn ip ipAddress isActive isCurrent isSimulated
    isSystem item itemCode itemCodes itemCount itemId items itemsSold karat key kind kpis label labelAr labelEn lastActivity
    lastActivityAt lastLoginAt lastSyncedAt latencyMs lines link listPrice liveSessions lockedUntil lockoutBaseMinutes
    lockoutMaxMinutes lockoutThreshold loginAt logins logoAssetId logoUrl maxDiscountPercent maxDiscountPercentByRole mg
    minPasswordLength minimumWithdrawalGrams mockHasad mode money movement movements mtd mustChangePassword n name nameAr
    nameEn nationalIdMasked netWeightMg newRequests note notes number ok openedAt openedBy openedByName opening openingItems
    openingWeightMg operation paidToCustomers params password passwordChangedAt payment paymentMethod pendingClaimStaleHours
    pendingExpenses pendingExpensesAmount period permissions phone pickupCode presence pricePerGram productId productName
    productNameAr purchaseId purchasedItems purchases purchasesCount queue rank rate rateChangeMaxPct rateKarats ratePerGram
    rateSource rates reason reauthWindowMinutes receivedAt receivedBy receivedByName recent redemptionId redemptionNumber
    ref refId refNumber refType request requestedAt requireGmApprovalForScrapOverride reservationRef
    reservationTimeoutMinutes reservedAt reservedBy reservedCount reservedItems response responseStatus returns revenue
    reviewNote reviewedAt reviewedBy role roleCode roleName roleRank rows saleId sales salesByCategory salesCount salesTotal
    scrapPriceTolerancePct security sellingPrice session sessionAbsoluteHours sessionId sessionIdleMinutes sessionRef setBy
    settings settlement settlementAmount settlementBasis settlementDirection settlementNumber severity simulateOutage sku
    staffCount status subtotal supplierCreditEnabled supplierId supplierInvoiceNo supplierName syncError syncedAt timeline
    timezone title to toBranchId toBranchName toStatus total totalNetWeightMg totals transferId transfers transfersIn
    transfersInTransit transfersOut trend type updatedAt user userAgent userFullName userId userName username validForMinutes
    versions voidReason voided voidedAt voidedBy voidedByName waiting weight weightDeliveredMg weightIn weightMg weightOut
    weightSoldMg withdrawableGrams withdrawal withdrawalId withdrawals hidden list key width height size mime uploadedAt
    temporaryPassword itemsReleased expectedDirection expectedAmount changed redemptionItemId version actorId actorUsername
    assetId origin supplierInvoiceRef pricingMode priceGoldValue priceMakingCharge priceRatePerGram paidFrom
    accountId eventType reversesEntryId idempotencyKey expectedCash bank fundsInTransit openingCash salesByMethod
    voidsByMethod voidsTotal expensesCash expensesBank settlementsCash settlementsBank cashMovement counted difference
    countedAmount expectedAmount countedBy countedByName businessDay
    makingChargePaidFrom paymentRefInvoice paymentRefTransaction scrapRatePerGram agreedRatePerGram deviationBp overrideApproved
    customerIdRef hasadReceivable posPaymentMethods brokenScrap pureMg24 brokenScrapPureMg24 itemsPureMg24 totalPureMg24 weightByKarat
    settlementCount purchaseNumber supplierName origin scrapRates byKarat balanceMg createdByName toleranceBp
    summary value itemsWeightMg brokenScrapWeightMg totalWeightMg stockWeight items settlements
    secondFactor required enrollmentRequired passkeys recoveryCodesRemaining recoveryCodesAcknowledged userVerification
    method requiredRoles signInMethod newDeviceAlert credentialNickname browser ipApprox uv newDevice nickname lastUsedAt
    uvAtRegistration backedUp deviceType methods expiresAt codes generatedAt validForMinutes revoked changed securityLocked recoveryCodesInvalidated
    backup backupAgeHours verifyAgeHours maxAgeHours maxVerifyAgeDays reasons
    goldOwedMgPure24 owedAfterMgPure24 goldDebtMgPure24 settledKarat settledWeightMg settledPureMg24 bankReference hasadReceivableToBank hasadReceivableBalance
    scrapPurchasesCash scrapPurchasesBank makingChargesCash makingChargesBank tolerancePct requireGmApproval rates
  `),
);

/**
 * Free-form containers: their inner keys are data (setting names, audit parameters, external
 * payloads), so they are not looked up in the registry — but they are still searched for COST names.
 */
export const OPAQUE_CONTAINERS: ReadonlySet<string> = new Set([
  'metadata',
  'descriptionParams',
  'params',
  'details',
  'settings',
  'versions',
  'value',
  'oldValue',
  'newValue',
  'request',
  'response',
  'body',
  'completion',
  'cancellation',
  'filters',
  // Phase 2fa: standard WebAuthn ceremony options (rp, user, challenge, allowCredentials…), sent only
  // by the …/options routes; never secrets of the server (the challenge is hashed at rest).
  'options',
]);

/**
 * Phase 2fa: field names that must NEVER appear in any API response, for any role (the camelCase of
 * every SECRET column, plus the obvious aliases). The response sweep fails on any of them.
 */
export const SECRET_RESPONSE_FIELDS: ReadonlySet<string> = new Set([
  'passwordHash',
  'webauthnUserHandle',
  'publicKey',
  'credentialPublicKey',
  'challengeHash',
  'codeHash',
  'pendingToken',
  'tokenHash',
]);

/** Keys that are data, not field names: karats ("21"), codes (KRT, CASHIER), setting keys, series ids (b3). */
export function isDynamicKey(k: string): boolean {
  return /^\d+$/.test(k) || /^[A-Z][A-Z0-9_]*$/.test(k) || /^[a-z]+\.[A-Za-z.]+$/.test(k) || /^b\d+$/.test(k);
}

export function classifyResponseField(name: string): FieldClass | undefined {
  if (COST_RESPONSE_FIELDS.has(name)) return 'COST';
  if (SAFE_RESPONSE_FIELDS.has(name) || OPAQUE_CONTAINERS.has(name) || isDynamicKey(name)) return 'SAFE';
  return undefined;
}

export interface FieldFinding {
  /** JSON path, e.g. ".rows[3].totalCost" or ".columns[5](key=grossProfit)". */
  path: string;
  name: string;
  kind: 'COST' | 'UNCLASSIFIED' | 'SECRET';
}

/**
 * Walk a response body. Reports every COST field (at any depth, inside arrays and opaque containers)
 * and every field name the registry does not know (outside opaque containers). Report column
 * descriptors (`columns: [{ key: 'totalCost', … }]`) count as the field they describe.
 */
export function scanResponse(body: unknown): FieldFinding[] {
  const out: FieldFinding[] = [];
  const walk = (v: unknown, path: string, opaque: boolean, parentKey: string | null) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        const p = `${path}[${i}]`;
        if (parentKey === 'columns' && x && typeof x === 'object' && typeof (x as { key?: unknown }).key === 'string') {
          const col = (x as { key: string }).key;
          const cls = classifyResponseField(col);
          if (cls === 'COST') out.push({ path: `${p}(key=${col})`, name: col, kind: 'COST' });
          else if (!cls && !opaque) out.push({ path: `${p}(key=${col})`, name: col, kind: 'UNCLASSIFIED' });
        }
        walk(x, p, opaque, parentKey);
      });
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = `${path}.${k}`;
      if (SECRET_RESPONSE_FIELDS.has(k)) out.push({ path: p, name: k, kind: 'SECRET' });
      const cls = classifyResponseField(k);
      // An audit parameter already replaced by the redaction marker carries no value.
      const redacted = !!x && typeof x === 'object' && (x as { hidden?: unknown }).hidden === true && Object.keys(x).length === 1;
      if (cls === 'COST' && !redacted) out.push({ path: p, name: k, kind: 'COST' });
      else if (!cls && !opaque) out.push({ path: p, name: k, kind: 'UNCLASSIFIED' });
      walk(x, p, opaque || OPAQUE_CONTAINERS.has(k), k);
    }
  };
  walk(body, '', false, null);
  return out;
}
