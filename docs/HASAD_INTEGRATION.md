# Hasad Gold Integration

## Boundary

The ERP talks to Hasad Gold **only** through `HasadService`
([`integrations/hasad/src/HasadService.ts`](../integrations/hasad/src/HasadService.ts)):

| Method | Purpose | Called when |
|---|---|---|
| `listWithdrawals(query)` | Pull new / updated requests | Hasad queue refresh (every few seconds, throttled) |
| `getWithdrawal(id)` | Re-validate a request | Cashier opens a request at the counter |
| `getCustomerEntitlement(customerId)` | Balance & withdrawable grams | Available for customer look-ups |
| `markInProgress(id, info)` | Lock the request on Hasad's side | Customer verified at the counter |
| `markReady(id)` | Unlock after an aborted visit | Customer leaves / reservation timeout |
| `completeWithdrawal(id, completion)` | Report delivered pieces and settlement | Cashier confirms the settlement |
| `cancelWithdrawal(id, reason)` | Cancel the request | Authorized user cancels |

Wire-level types (string grams, external IDs, ISO dates) are in `integrations/hasad/src/types.ts`.
`backend/src/modules/hasad/sync.ts` is the anti-corruption layer that maps them to ERP records.
No other module imports Hasad types.

## The mock

`MockHasadService` behaves like a remote system:
- its own tables in a separate Postgres schema `hasad_mock` (customers with Haba balances,
  withdrawals, API call log)
- a state machine (`PENDING → READY_FOR_PICKUP → IN_PROGRESS → COMPLETED | CANCELLED`)
- configurable latency and a **simulated outage** switch (Settings), which returns 503 errors
- a log of every call, visible in *Hasad Simulator → Integration log*

## Replacing the mock

1. Implement `HttpHasadService implements HasadService` (auth, retries, timeouts).
2. Return it from `createHasadIntegration()` in [`backend/src/integrations.ts`](../backend/src/integrations.ts).
3. Map real branch codes in `branches.hasad_branch_code`.
4. Optional: add a signed webhook endpoint that calls `syncWithdrawals(ctx, true)`.
5. Drop the `hasad_mock` schema.

## Consistency rules implemented
- Receiving a request **never touches inventory**.
- On completion, the ERP validates everything locally **before** notifying Hasad, then commits the
  ERP changes (item REDEEMED, ledger, settlement) in one transaction. Production hardening: an
  outbox with the ERP redemption number as idempotency key.
- The settlement shown to the cashier is re-checked by the server at completion. If the gold rate
  or selection changed, completion is refused (HTTP 409) and the cashier re-confirms.
- Releasing reserved stock is never blocked by Hasad being unavailable.
- The pickup code is verified server-side and never sent to the browser.

## Open questions for the client
1. Is the entitlement in 21K grams, pure (24K) grams, or "grams of any karat"? (Setting: *basis*.)
2. Which rate values the difference? (Setting: *rate source*: piece karat vs entitlement karat.)
3. Is a making charge applied on redemption?
4. Can a customer take several pieces against one withdrawal? (Supported.)
5. How should Hasad redemptions be recognized in branch revenue/profit? (Reported separately today.)
