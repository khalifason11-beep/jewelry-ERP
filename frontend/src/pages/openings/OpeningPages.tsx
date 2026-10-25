// OPN-1 (plan docs/plans/OPN-1.md §4–§5, D-opn1-1..7): the opening balance of each branch, General Manager only.
//   * OpeningsPage: every active branch with its opening (none, draft or sealed); "Start" creates the draft (once per
//     branch).
//   * OpeningPage: the draft is not stock yet. Pieces are typed in (type, karat, description, weights; Enter moves to
//     the next field and adds the line) or imported from a CSV file (the template downloads here); a refused file shows
//     every problem with its row and column, and nothing is imported. The review shows the count and weight by karat
//     and by type, the lines paged and searchable, and a CSV export. Sealing shows the summary and a checklist, asks the
//     password and a passkey confirmation, then every line becomes a piece (cost unknown, price from the new-piece
//     rate) and nothing can change any more; the export then lists the codes to write on the tags.

import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileUp, Fingerprint, Lock, Plus, Trash2 } from 'lucide-react';
import { fetchAllPages, parseWeightInput, type Page } from '@jerp/shared';
import { ApiError, api, errorText, get, postOnce } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { useActionKeys } from '../../lib/idempotency';
import { useDebounced } from '../../lib/hooks';
import { dateTime, grams, karatLabel, num } from '../../lib/format';
import { Alert, Badge, Button, Card, CardHeader, DataTable, DetailPending, Dialog, Field, Input, Mono, PageHeader, Select, StatusBadge, WeightInput } from '../../components/ui';
import { PieceKindFields, descriptionTooLong, emptyKind, type PieceKindValue } from '../../components/PieceKind';
import { confirmWithPasskey } from '../../components/ReauthDialog';
import { OpeningCorrectionsCard, type OpeningCorrectionRow } from '../inventory/OpeningCorrection';

type Condition = 'NEW' | 'USED';
interface OpeningRow {
  branchId: number;
  branchCode: string;
  branchName: string;
  branchNameAr: string;
  opening: { id: number; status: 'DRAFT' | 'SEALED'; createdAt: string; sealedAt: string | null; lineCount: number; netWeightMg: number } | null;
}
interface Summary {
  total: { count: number; grossWeightMg: number; netWeightMg: number };
  byKarat: { karat: number; count: number; grossWeightMg: number; netWeightMg: number }[];
  /** OPN-2: by karat and condition (the rate each group needs). */
  byKaratCondition: { karat: number; condition: Condition; count: number; grossWeightMg: number; netWeightMg: number }[];
  byType: { categoryId: number; categoryName: string | null; categoryNameAr: string; count: number; netWeightMg: number }[];
}
interface Line {
  id: number;
  lineNo: number;
  categoryId: number;
  categoryName: string | null;
  categoryNameAr: string;
  description: string | null;
  karat: number;
  /** OPN-2: NULL only on a line sealed before OPN-2 (its piece is priced as new, D-opn2-3). */
  condition: Condition | null;
  grossWeightMg: number;
  netWeightMg: number;
  source: 'KEYBOARD' | 'IMPORT';
  code: string | null;
  barcode: string | null;
  /** OPN-FIX: the piece's status now (sealed openings). */
  itemStatus?: string | null;
}
interface Opening {
  id: number;
  branchId: number;
  branchCode: string;
  branchName: string;
  branchNameAr: string;
  status: 'DRAFT' | 'SEALED';
  createdAt: string;
  sealedAt: string | null;
  summary: Summary;
  imports: { id: number; fileName: string; rowCount: number; createdAt: string }[];
  lines: Page<Line>;
  /** OPN-FIX: once sealed, the pieces as they are now (voided out, corrected values in) and the corrections. */
  now: { total: { count: number; grossWeightMg: number; netWeightMg: number }; byKaratCondition: Summary['byKaratCondition']; voided: number; sold: number } | null;
  corrections: (OpeningCorrectionRow & { code: string })[];
}
interface ImportProblem {
  line: number;
  column: string | null;
  key: string;
  params?: Record<string, string | number>;
}

const COLUMN_LABELS: Record<string, string> = { type: 'Type', description: 'Description', karat: 'Karat', condition: 'Condition', grossWeight: 'Gross weight', netWeight: 'Net weight' };
/** OPN-2: the condition decides the rate that prices the piece (new-piece or used-piece rate). */
const CONDITION_LABELS: Record<Condition, string> = { NEW: 'New', USED: 'Used' };
/** "21K new", "21K used": a group of the review and the rate it needs. */
const karatCondition = (k: { karat: number; condition: Condition }, t: (k: string) => string) => `${karatLabel(k.karat)} ${t(CONDITION_LABELS[k.condition])}`;
const statusBadge = (status: 'DRAFT' | 'SEALED' | null, t: (k: string) => string) =>
  status === 'SEALED' ? <Badge tone="ok">{t('SEALED')}</Badge> : status === 'DRAFT' ? <Badge tone="warn">{t('DRAFT')}</Badge> : <Badge>{t('Not started')}</Badge>;

export function OpeningsPage() {
  const { t, L } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const list = useQuery({ queryKey: ['openings'], queryFn: () => get<{ branches: OpeningRow[] }>('/openings') });
  const start = useMutation({
    mutationFn: (branchId: number) => postOnce<{ id: number }>('/openings', { branchId }, keys.for(`opening-${branchId}`)),
    onSuccess: (o, branchId) => {
      keys.rotate(`opening-${branchId}`);
      qc.invalidateQueries({ queryKey: ['openings'] });
      navigate(`/openings/${o.id}`);
    },
    onError: (e, branchId) => {
      keys.rotate(`opening-${branchId}`);
      toast.fromError(e);
    },
  });
  const rows = list.data?.branches ?? [];
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Opening balance')}
        subtitle={t('The pieces each branch already holds on the first day, entered once. Their cost is unknown; they sell at the new-piece or the used-piece rate, by their condition.')}
      />
      <Card padded={false}>
        <DataTable
          query={list}
          rows={rows}
          rowKey={(r) => r.branchId}
          searchable={false}
          onRowClick={(r) => r.opening && navigate(`/openings/${r.opening.id}`)}
          emptyTitle={t('No active branch')}
          columns={[
            { key: 'branch', header: t('Branch'), value: (r) => L(r.branchName, r.branchNameAr), render: (r) => L(r.branchName, r.branchNameAr) },
            { key: 'status', header: t('Status'), value: (r) => r.opening?.status ?? '', render: (r) => statusBadge(r.opening?.status ?? null, t) },
            { key: 'count', header: t('Pieces'), align: 'end', value: (r) => r.opening?.lineCount ?? 0, render: (r) => (r.opening ? num(r.opening.lineCount) : '—') },
            { key: 'weight', header: t('Net weight'), align: 'end', value: (r) => r.opening?.netWeightMg ?? 0, render: (r) => (r.opening ? grams(r.opening.netWeightMg) : '—') },
            { key: 'sealedAt', header: t('Sealed'), value: (r) => r.opening?.sealedAt ?? '', render: (r) => (r.opening?.sealedAt ? dateTime(r.opening.sealedAt) : '—') },
            {
              key: 'actions',
              header: '',
              sortable: false,
              render: (r) =>
                r.opening ? (
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/openings/${r.opening!.id}`)} data-testid={`opening-open-${r.branchCode}`}>{t('Open')}</Button>
                ) : (
                  <Button size="sm" variant="primary" loading={start.isPending && start.variables === r.branchId} onClick={() => start.mutate(r.branchId)} data-testid={`opening-start-${r.branchCode}`}>{t('Start')}</Button>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

export function OpeningPage() {
  const { id } = useParams();
  const { t, L } = useI18n();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const params = { page: dq ? 1 : page, pageSize: 50, ...(dq ? { q: dq } : {}) };
  const opening = useQuery({ queryKey: ['opening', id, params], queryFn: () => get<Opening>(`/openings/${id}`, params), placeholderData: keepPreviousData });
  if (!opening.data) return <DetailPending query={opening} backTo="/openings" backLabel={t('Back to the opening balances')} notFoundTitle={t('This opening does not exist')} />;
  const o = opening.data;
  const draft = o.status === 'DRAFT';
  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        breadcrumbs={<Link to="/openings" className="hover:underline">{t('Opening balance')}</Link>}
        title={
          <span className="flex items-center gap-3">
            {t('Opening balance of {branch}', { branch: L(o.branchName, o.branchNameAr) })} {statusBadge(o.status, t)}
          </span>
        }
        subtitle={draft ? t('A draft is not stock yet: nothing here can be sold or moved until it is sealed.') : t('Sealed on {date}: every line is a piece in stock. Nothing can be added or changed.', { date: dateTime(o.sealedAt) })}
        actions={
          <>
            {draft && (
              <a href="/api/openings/template.csv" download className="inline-flex" data-testid="opening-template">
                <Button icon={<Download className="size-4" />}>{t('CSV template')}</Button>
              </a>
            )}
            <a href={`/api/openings/${o.id}/export`} download className="inline-flex" data-testid="opening-export">
              <Button icon={<Download className="size-4" />}>{draft ? t('Export the draft (CSV)') : t('Export the pieces with their codes (CSV)')}</Button>
            </a>
          </>
        }
      />
      <SummaryCards summary={o.summary} />
      {o.now && o.corrections.length > 0 && (
        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <NowCard now={o.now} />
          <OpeningCorrectionsCard rows={o.corrections} showCode />
        </div>
      )}
      {draft && (
        <div className="mb-4 grid gap-4 xl:grid-cols-2">
          <KeyboardEntry openingId={o.id} />
          <ImportPanel openingId={o.id} imports={o.imports} />
        </div>
      )}
      {draft && <SealPanel opening={o} />}
      <div className="mt-4" data-testid="opening-lines">
      <Card padded={false}>
        <CardHeader title={t('Lines')} subtitle={t('{n} line(s)', { n: num(o.summary.total.count) })} />
        <DataTable
          query={opening}
          rows={o.lines.rows}
          rowKey={(r) => r.id}
          exportName={`opening-${o.branchCode}`}
          emptyTitle={dq ? t('No line matches') : t('No pieces yet')}
          emptyBody={draft && !dq ? t('Type the pieces in, or import the CSV file of the branch.') : undefined}
          server={{
            page: o.lines.page,
            total: o.lines.total,
            onPage: setPage,
            sortKeys: {},
            sort: null,
            onSort: () => undefined,
            search: { value: q, onChange: setQ },
            exportAll: () => fetchAllPages((p) => get<Opening>(`/openings/${id}`, { ...p, ...(dq ? { q: dq } : {}) }).then((x) => x.lines)),
          }}
          searchPlaceholder={t('Search type, description or code')}
          columns={[
            { key: 'lineNo', header: '#', render: (r) => <Mono>{r.lineNo}</Mono> },
            ...(draft
              ? []
              : [
                  {
                    key: 'code',
                    header: t('Code'),
                    // OPN-FIX: a piece that is no longer in stock says so (voided after a correction, sold…).
                    render: (r: Line) => (
                      <span className="inline-flex items-center gap-1.5">
                        <Mono>{r.code ?? '—'}</Mono>
                        {r.itemStatus && r.itemStatus !== 'AVAILABLE' && <StatusBadge status={r.itemStatus} />}
                      </span>
                    ),
                  },
                ]),
            { key: 'type', header: t('Type'), value: (r) => L(r.categoryName, r.categoryNameAr), render: (r) => L(r.categoryName, r.categoryNameAr) },
            { key: 'description', header: t('Description'), value: (r) => r.description ?? '', render: (r) => r.description ?? '—' },
            { key: 'karat', header: t('Karat'), value: (r) => r.karat, render: (r) => karatLabel(r.karat) },
            { key: 'condition', header: t('Condition'), value: (r) => r.condition ?? '', render: (r) => (r.condition ? t(CONDITION_LABELS[r.condition]) : '—') },
            { key: 'gross', header: t('Gross weight'), align: 'end', value: (r) => r.grossWeightMg, render: (r) => grams(r.grossWeightMg) },
            { key: 'net', header: t('Net weight'), align: 'end', value: (r) => r.netWeightMg, render: (r) => grams(r.netWeightMg) },
            { key: 'source', header: t('Entered by'), value: (r) => r.source, render: (r) => (r.source === 'IMPORT' ? t('IMPORT') : t('KEYBOARD')) },
            ...(draft ? [{ key: 'remove', header: '', sortable: false, render: (r: Line) => <RemoveLine openingId={o.id} line={r} /> }] : []),
          ]}
        />
      </Card>
      </div>
    </div>
  );
}

/** OPN-FIX: the sealed opening's pieces now, after the corrections (the totals above stay as sealed). */
function NowCard({ now }: { now: NonNullable<Opening['now']> }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader title={t('Now, after the corrections')} subtitle={t('{n} piece(s), {weight} net; {voided} voided, {sold} sold', { n: num(now.total.count), weight: grams(now.total.netWeightMg), voided: num(now.voided), sold: num(now.sold) })} />
      <table className="w-full text-[13px]" data-testid="opening-now">
        <tbody>
          {now.byKaratCondition.map((k) => (
            <tr key={`${k.karat}-${k.condition}`} className="border-t border-line">
              <td className="py-1">{karatCondition(k, t)}</td>
              <td className="py-1 text-end num">{num(k.count)}</td>
              <td className="py-1 text-end num">{grams(k.netWeightMg)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function SummaryCards({ summary }: { summary: Summary }) {
  const { t, L } = useI18n();
  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-2" data-testid="opening-summary">
      <Card>
        <CardHeader title={t('By karat and condition')} subtitle={t('{n} piece(s), {weight} net', { n: num(summary.total.count), weight: grams(summary.total.netWeightMg) })} />
        <table className="w-full text-[13px]">
          <thead className="text-ink-3">
            <tr><th className="py-1 text-start font-medium">{t('Karat')}</th><th className="py-1 text-start font-medium">{t('Condition')}</th><th className="py-1 text-end font-medium">{t('Pieces')}</th><th className="py-1 text-end font-medium">{t('Gross weight')}</th><th className="py-1 text-end font-medium">{t('Net weight')}</th></tr>
          </thead>
          <tbody>
            {summary.byKaratCondition.map((k) => (
              <tr key={`${k.karat}-${k.condition}`} className="border-t border-line" data-testid={`opening-karat-${k.karat}-${k.condition}`}>
                <td className="py-1">{karatLabel(k.karat)}</td>
                <td className="py-1">{t(CONDITION_LABELS[k.condition])}</td>
                <td className="py-1 text-end num">{num(k.count)}</td>
                <td className="py-1 text-end num">{grams(k.grossWeightMg)}</td>
                <td className="py-1 text-end num">{grams(k.netWeightMg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card>
        <CardHeader title={t('By type')} />
        <table className="w-full text-[13px]">
          <thead className="text-ink-3">
            <tr><th className="py-1 text-start font-medium">{t('Type')}</th><th className="py-1 text-end font-medium">{t('Pieces')}</th><th className="py-1 text-end font-medium">{t('Net weight')}</th></tr>
          </thead>
          <tbody>
            {summary.byType.map((x) => (
              <tr key={x.categoryId} className="border-t border-line">
                <td className="py-1">{L(x.categoryName, x.categoryNameAr)}</td>
                <td className="py-1 text-end num">{num(x.count)}</td>
                <td className="py-1 text-end num">{grams(x.netWeightMg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** One piece typed in. Enter moves to the next field; on the last one it adds the line and starts the next. */
function KeyboardEntry({ openingId }: { openingId: number }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const [kind, setKind] = useState<PieceKindValue>(emptyKind());
  // OPN-2: required, nothing preselected, and chosen again for every piece (never carried over by mistake).
  const [condition, setCondition] = useState<Condition | ''>('');
  const [gross, setGross] = useState('');
  const [net, setNet] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const grossMg = parseWeightInput(gross);
  const netMg = parseWeightInput(net);
  const missing = !kind.categoryId
    ? t('Choose the item type')
    : !kind.karat
      ? t('Choose the karat')
      : descriptionTooLong(kind.description)
        ? t('A description can have at most 120 characters')
        : !condition
          ? t('Choose the condition: new or used')
          : !grossMg
          ? t('Enter the gross weight')
          : !netMg
            ? t('Enter the net weight')
            : grossMg < netMg
              ? t('The gross weight cannot be below the net weight')
              : null;
  const add = useMutation({
    mutationFn: () =>
      postOnce(`/openings/${openingId}/lines`, { categoryId: kind.categoryId, karat: kind.karat, description: kind.description.trim() || null, condition, grossWeightMg: grossMg, netWeightMg: netMg }, keys.for('opening-line')),
    onSuccess: () => {
      keys.rotate('opening-line');
      // The next piece keeps the type and the karat (a sheet is often one type at a time); the condition and the weights
      // start empty.
      setKind((k) => ({ ...k, description: '' }));
      setCondition('');
      setGross('');
      setNet('');
      qc.invalidateQueries({ queryKey: ['opening'] });
      box.current?.querySelector<HTMLInputElement>('[data-testid="opening-kind-description"]')?.focus();
    },
    onError: (e) => {
      keys.rotate('opening-line');
      toast.fromError(e);
    },
  });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (e.key !== 'Enter' || (el.tagName !== 'INPUT' && el.tagName !== 'SELECT')) return;
    e.preventDefault();
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('input:not([disabled]), select:not([disabled])')];
    const next = all[all.indexOf(el) + 1];
    if (next) next.focus();
    else if (!missing) add.mutate();
  };
  return (
    <Card>
      <CardHeader title={t('Type a piece')} subtitle={t('Enter moves to the next field; on the last one it adds the piece.')} />
      <div ref={box} onKeyDown={onKey} className="space-y-2" data-testid="opening-keyboard">
        <PieceKindFields value={kind} onChange={setKind} testId="opening-kind" />
        <div className="grid grid-cols-3 gap-2">
          <Field label={t('Condition')}>
            <Select value={condition} onChange={(e) => setCondition(e.target.value as Condition | '')} data-testid="opening-condition">
              <option value="">{t('Choose…')}</option>
              <option value="NEW">{t('New')}</option>
              <option value="USED">{t('Used')}</option>
            </Select>
          </Field>
          <Field label={t('Gross weight (g)')}>
            <WeightInput value={gross} onValueChange={setGross} data-testid="opening-gross" />
          </Field>
          <Field label={t('Net weight (g)')}>
            <WeightInput value={net} onValueChange={setNet} data-testid="opening-net" />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-meta text-ink-3">{missing ?? ''}</span>
          <Button variant="primary" icon={<Plus className="size-4" />} disabled={!!missing} loading={add.isPending} onClick={() => add.mutate()} data-testid="opening-add-line">{t('Add the piece')}</Button>
        </div>
      </div>
    </Card>
  );
}

/** The CSV file of the branch: all rows or none; the same file twice changes nothing. */
function ImportPanel({ openingId, imports }: { openingId: number; imports: Opening['imports'] }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const file = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [problems, setProblems] = useState<{ count: number; list: ImportProblem[] } | null>(null);
  const run = useMutation({
    mutationFn: (f: File) =>
      api<{ rowCount: number; duplicate: boolean; fileName: string }>(`/openings/${openingId}/import`, {
        method: 'POST',
        // Windows may label a CSV "application/vnd.ms-excel": the server reads text/csv only.
        raw: new Blob([f], { type: 'text/csv' }),
        query: { fileName: f.name },
        idempotencyKey: keys.for('opening-import'),
      }),
    onSuccess: (r) => {
      keys.rotate('opening-import');
      setProblems(null);
      setChosen(null);
      if (file.current) file.current.value = '';
      toast.success(r.duplicate ? t('This file was already imported: nothing changed') : t('{n} piece(s) imported from {file}', { n: r.rowCount, file: r.fileName }));
      qc.invalidateQueries({ queryKey: ['opening'] });
    },
    onError: (e) => {
      keys.rotate('opening-import');
      const d = e instanceof ApiError ? (e.details as { errors?: ImportProblem[]; errorCount?: number } | undefined) : undefined;
      if (d?.errors) setProblems({ count: d.errorCount ?? d.errors.length, list: d.errors });
      else toast.fromError(e);
    },
  });
  return (
    <Card>
      <CardHeader title={t('Import a CSV file')} subtitle={t('Columns: type, description, karat, condition (new or used), gross weight, net weight (Arabic or English names). Excel: "Save as CSV UTF-8".')} />
      <div className="flex flex-wrap items-center gap-2">
        <input ref={file} type="file" accept=".csv,text/csv" onChange={(e) => { setChosen(e.target.files?.[0] ?? null); setProblems(null); }} className="text-[13px]" data-testid="opening-file" />
        <Button variant="primary" icon={<FileUp className="size-4" />} disabled={!chosen} loading={run.isPending} onClick={() => chosen && run.mutate(chosen)} data-testid="opening-import">{t('Import')}</Button>
      </div>
      {problems && (
        <Alert tone="danger" className="mt-3" data-testid="opening-import-problems">
          <p className="mb-2 font-medium">{t('The file has {count} problem(s): nothing was imported', { count: problems.count })}</p>
          <table className="w-full text-[12.5px]">
            <thead><tr><th className="text-start font-medium">{t('Row')}</th><th className="text-start font-medium">{t('Column')}</th><th className="text-start font-medium">{t('Problem')}</th></tr></thead>
            <tbody>
              {problems.list.map((p, i) => (
                <tr key={i} data-testid="opening-import-problem">
                  <td className="pe-3 num">{p.line}</td>
                  <td className="pe-3">{p.column ? t(COLUMN_LABELS[p.column] ?? p.column) : '—'}</td>
                  <td>{t(p.key, p.params)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {problems.count > problems.list.length && <p className="mt-1">{t('… and {n} more', { n: problems.count - problems.list.length })}</p>}
        </Alert>
      )}
      {imports.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-meta text-ink-3" data-testid="opening-imports">
          {imports.map((i) => (
            <li key={i.id}>{t('{file}: {n} piece(s), {date}', { file: i.fileName, n: i.rowCount, date: dateTime(i.createdAt) })}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RemoveLine({ openingId, line }: { openingId: number; line: Line }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const m = useMutation({
    mutationFn: () => postOnce(`/openings/${openingId}/lines/${line.id}/remove`, {}, keys.for(`remove-${line.id}`)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['opening'] }),
    onError: (e) => {
      keys.rotate(`remove-${line.id}`);
      toast.fromError(e);
    },
  });
  return (
    <button
      type="button"
      onClick={() => m.mutate()}
      disabled={m.isPending}
      className="flex size-8 items-center justify-center rounded-control text-ink-400 hover:text-rose-600"
      aria-label={t('Remove line {n}', { n: line.lineNo })}
      data-testid={`opening-remove-${line.lineNo}`}
    >
      <Trash2 className="size-4" />
    </button>
  );
}

/** The checklist and the seal: the summary first, then the password and a passkey confirmation (D-opn1-5). */
function SealPanel({ opening }: { opening: Opening }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rates = useMemo(() => opening.summary.byKaratCondition.map((k) => karatCondition(k, t)).join('، '), [opening.summary.byKaratCondition, t]);
  return (
    <Card>
      <CardHeader title={t('Before sealing')} />
      <ul className="mb-3 list-disc space-y-1 ps-5 text-[13px]" data-testid="opening-checklist">
        <li>
          {t('Register a passkey on this device (sealing asks for it).')} <Link to="/security" className="text-gold-700 hover:underline">{t('Security')}</Link>
        </li>
        <li>
          {t('Switch on computed prices and set the selling rate of every karat and condition in the sheet (new pieces: the new-piece rate; used pieces: the used-piece rate): {rates}.', { rates: rates || '—' })}{' '}
          <Link to="/prices" className="text-gold-700 hover:underline">{t('Prices')}</Link>
        </li>
        <li>{t('Review the draft: the totals above against the paper count, and the lines below (or the CSV export).')}</li>
        <li>{t('After sealing nothing can be added or changed here; each piece gets its code in the order of the sheet.')}</li>
      </ul>
      <Button variant="primary" icon={<Lock className="size-4" />} disabled={opening.summary.total.count === 0} onClick={() => setOpen(true)} data-testid="opening-seal">
        {t('Seal the opening balance')}
      </Button>
      {open && <SealDialog opening={opening} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function SealDialog({ opening, onClose }: { opening: Opening; onClose: () => void }) {
  const { t, L } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const keys = useActionKeys();
  const [password, setPassword] = useState('');
  const [passkeyDone, setPasskeyDone] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const passkey = useMutation({
    mutationFn: confirmWithPasskey,
    onSuccess: () => {
      setPasskeyDone(true);
      setPasskeyError(null);
    },
    onError: (e) => setPasskeyError(errorText(e)),
  });
  const seal = useMutation({
    mutationFn: () => postOnce<{ pieces: number; firstCode: string; lastCode: string }>(`/openings/${opening.id}/seal`, { confirmPassword: password }, keys.for('opening-seal')),
    onSuccess: (r) => {
      keys.rotate('opening-seal');
      toast.success(t('Opening sealed: {n} piece(s), codes {first} to {last}', { n: r.pieces, first: r.firstCode, last: r.lastCode }));
      qc.invalidateQueries();
      onClose();
    },
    onError: (e) => {
      keys.rotate('opening-seal');
      toast.fromError(e);
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Seal the opening balance of {branch}', { branch: L(opening.branchName, opening.branchNameAr) })}
      subtitle={t('Every line becomes a piece in stock with an unknown cost. This cannot be undone.')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="danger-solid" icon={<Lock className="size-4" />} disabled={!password || !passkeyDone} loading={seal.isPending} onClick={() => seal.mutate()} data-testid="opening-seal-confirm">
            {t('Seal')}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[13px]" data-testid="opening-seal-summary">
        {t('{n} piece(s), {weight} net:', { n: num(opening.summary.total.count), weight: grams(opening.summary.total.netWeightMg) })}{' '}
        {opening.summary.byKaratCondition.map((k) => `${karatCondition(k, t)} ${num(k.count)} / ${grams(k.netWeightMg)}`).join(' · ')}
      </p>
      <Field label={t('Your password')}>
        <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="opening-seal-password" />
      </Field>
      <div className="mt-3 flex items-center gap-3">
        <Button icon={passkeyDone ? <CheckCircle2 className="size-4" /> : <Fingerprint className="size-4" />} disabled={passkeyDone} loading={passkey.isPending} onClick={() => passkey.mutate()} data-testid="opening-seal-passkey">
          {passkeyDone ? t('Passkey confirmed') : t('Confirm with your passkey')}
        </Button>
      </div>
      {passkeyError && <Alert tone="danger" className="mt-2">{passkeyError}</Alert>}
    </Dialog>
  );
}
