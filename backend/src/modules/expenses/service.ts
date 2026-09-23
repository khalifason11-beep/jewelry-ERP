import { and, desc, eq, gte, ilike, lte, or, type SQL } from 'drizzle-orm';
import { t } from '@jerp/database';
import type { ExpenseCategory } from '@jerp/shared';
import type { Actor, Ctx } from '../../core/context';
import { branchScope, can, requirePerm } from '../../authz';
import { writeAudit } from '../../core/audit';
import { badRequest, notFound } from '../../core/errors';
import { nextNumber } from '../../core/numbering';
import { dayKey } from '../../core/time';

export interface CreateExpenseInput {
  branchId?: number;
  category: ExpenseCategory;
  amount: number;
  expenseDate?: string;
  description: string;
}

export async function createExpense(ctx: Ctx, actor: Actor, input: CreateExpenseInput, opts: { at?: Date } = {}) {
  requirePerm(actor, 'expenses.create');
  const branchId = branchScope(actor, input.branchId);
  if (branchId == null) throw badRequest('Select a branch');
  if (!(input.amount > 0)) throw badRequest('Amount must be positive');
  if (!input.description?.trim()) throw badRequest('Description is required');
  const settings = await ctx.settings.get();
  const needsApproval = input.amount > settings.expenses.approvalThreshold && !can(actor, 'expenses.approve');
  const at = opts.at ?? new Date();
  return ctx.db.transaction(async (tx) => {
    const [branch] = await tx.select().from(t.branches).where(eq(t.branches.id, branchId));
    const number = await nextNumber(tx, branch.code, 'EXP');
    const [row] = await tx
      .insert(t.expenses)
      .values({
        number,
        branchId,
        category: input.category,
        amount: Math.round(input.amount),
        expenseDate: input.expenseDate ?? dayKey(at, settings.company.timezone),
        description: input.description.trim(),
        status: needsApproval ? 'PENDING' : 'APPROVED',
        createdBy: actor.userId,
        createdAt: at,
      })
      .returning();
    await writeAudit(tx, actor, {
      action: 'EXPENSE_CREATED',
      entityType: 'expense',
      entityId: number,
      branchId,
      at,
      description: `Expense ${number} (${input.category}) ${Math.round(input.amount).toLocaleString()} SDG — ${input.description.trim()}${needsApproval ? ' [pending GM approval]' : ''}`,
    });
    return row;
  });
}

export async function reviewExpense(ctx: Ctx, actor: Actor, id: number, decision: 'APPROVED' | 'REJECTED', note?: string) {
  requirePerm(actor, 'expenses.approve');
  return ctx.db.transaction(async (tx) => {
    const [e] = await tx.select().from(t.expenses).where(eq(t.expenses.id, id));
    if (!e) throw notFound('Expense');
    branchScope(actor, e.branchId);
    if (e.status !== 'PENDING') throw badRequest(`Expense is already ${e.status}`);
    await tx
      .update(t.expenses)
      .set({ status: decision, reviewedBy: actor.userId, reviewedAt: new Date(), reviewNote: note ?? null })
      .where(eq(t.expenses.id, id));
    await writeAudit(tx, actor, {
      action: decision === 'APPROVED' ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
      entityType: 'expense',
      entityId: e.number,
      branchId: e.branchId,
      description: `Expense ${e.number} ${decision.toLowerCase()} (${e.amount.toLocaleString()} SDG)${note ? `: ${note}` : ''}`,
    });
    return { ok: true };
  });
}

export async function listExpenses(
  ctx: Ctx,
  actor: Actor,
  q: { branchId?: number; from?: string; to?: string; category?: string; status?: string; q?: string },
) {
  requirePerm(actor, 'expenses.view');
  const scope = branchScope(actor, q.branchId);
  const where: SQL[] = [];
  if (scope != null) where.push(eq(t.expenses.branchId, scope));
  if (q.from) where.push(gte(t.expenses.expenseDate, q.from));
  if (q.to) where.push(lte(t.expenses.expenseDate, q.to));
  if (q.category) where.push(eq(t.expenses.category, q.category));
  if (q.status) where.push(eq(t.expenses.status, q.status));
  if (q.q?.trim()) {
    const s = `%${q.q.trim()}%`;
    where.push(or(ilike(t.expenses.number, s), ilike(t.expenses.description, s))!);
  }
  return ctx.db
    .select({
      id: t.expenses.id,
      number: t.expenses.number,
      branchId: t.expenses.branchId,
      branchName: t.branches.name,
      category: t.expenses.category,
      amount: t.expenses.amount,
      expenseDate: t.expenses.expenseDate,
      description: t.expenses.description,
      status: t.expenses.status,
      createdByName: t.users.fullName,
      createdAt: t.expenses.createdAt,
      reviewNote: t.expenses.reviewNote,
    })
    .from(t.expenses)
    .innerJoin(t.branches, eq(t.branches.id, t.expenses.branchId))
    .innerJoin(t.users, eq(t.users.id, t.expenses.createdBy))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(t.expenses.expenseDate), desc(t.expenses.id))
    .limit(1000);
}
