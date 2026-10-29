// First steps on an empty system (REM-3, docs/ux/ANALYSIS.md §8): six steps (UX-4) before the first sale, shown
// on the General Manager's home until every step is really done (the server derives each one from data).
// Restyled in UI-B as a home panel (mockup empty-gm-home.html); five steps, not the mockup's three (REM-3 added karats,
// CSH-2 "Fund the branch": the drawer cannot pay out money that was never recorded).

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2 } from 'lucide-react';
import { KARATS } from '@jerp/shared';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { karatLabel } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/toast';
import { Button, Dialog, Panel, PanelHeader } from './ui';
import { ensureFresh } from '../lib/reauth';

export type SetupStepKey = 'branch' | 'karats' | 'rates' | 'staff' | 'opening' | 'fund';
export interface SetupStatus {
  complete: boolean;
  /** UX-4: the opening step carries its state (and the draft to open); only for whoever can enter the opening. */
  steps: { key: SetupStepKey; done: boolean; state?: 'NOT_STARTED' | 'DRAFT' | 'SEALED'; openingId?: number }[];
  allowedKarats: number[];
}

export function useSetupStatus(enabled = true) {
  return useQuery({ queryKey: ['setup-status'], queryFn: () => get<SetupStatus>('/setup/status'), enabled });
}

const link = 'text-[13px] font-medium text-gold-700 hover:underline';

export function FirstSteps({ status }: { status: SetupStatus }) {
  const { t } = useI18n();
  const [karats, setKarats] = useState(false);
  const done = status.steps.filter((s) => s.done).length;
  // UX-4: one short line per step (UX-2 rules), in the owner's order; the opening balance says which of its three
  // states it is in, and a draft says it is not stock yet.
  const text = (s: SetupStatus['steps'][number]): { title: string; body?: string; action: React.ReactNode } => {
    switch (s.key) {
      case 'branch':
        return { title: t('Create the first branch'), action: <Link to="/branches" className={link}>{t('New branch')}</Link> };
      case 'karats':
        return { title: t('Confirm the karats you sell'), action: <Button size="sm" variant="primary" onClick={async () => (await ensureFresh()) && setKarats(true)} data-testid="step-karats-action">{t('Confirm karats')}</Button> };
      case 'rates':
        return { title: t('Set the gold rates'), body: t('Every karat, new and used, and the scrap rate.'), action: <Link to="/prices" className={link} data-testid="step-rates-action">{t('Set rates')}</Link> };
      case 'staff':
        return { title: t('Add the branch manager and a cashier'), action: <Link to="/users" className={link}>{t('New user')}</Link> };
      case 'opening':
        return s.state === 'DRAFT'
          ? { title: t('Seal the opening balance'), body: t('Not in stock yet: seal it so the cashier can sell it.'), action: <Link to={`/openings/${s.openingId}`} className={link} data-testid="step-opening-action">{t('Open the draft')}</Link> }
          : s.state === 'SEALED'
            ? { title: t('Opening balance sealed'), action: null }
            : { title: t('Enter the opening balance'), body: t('The pieces each branch already holds.'), action: <Link to="/openings" className={link} data-testid="step-opening-action">{t('Opening balance')}</Link> };
      case 'fund':
        return { title: t('Fund the branch'), body: t('Record the money in the drawer as an advance.'), action: <Link to="/cash" className={link} data-testid="step-fund-action">{t('Record an advance')}</Link> };
    }
  };
  return (
    <div className="mb-4" data-testid="first-steps">
    <Panel label={t('First steps')}>
      <PanelHeader title={t('First steps')} action={<span className="num">{t('{done} of {total} done', { done, total: status.steps.length })}</span>} />
      <div className="mx-1 mb-2 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
        <div className="h-full bg-navy" style={{ width: `${(done / status.steps.length) * 100}%` }} />
      </div>
      <ol className="grid grid-cols-1 gap-1.5">
        {status.steps.map((s, i) => {
          const x = text(s);
          return (
            <li key={s.key} className="flex items-center gap-4 rounded-row bg-surface px-3 py-2.5" data-testid={`step-${s.key}`} data-done={s.done ? 'true' : 'false'} data-state={s.state}>
              <span className={clsx('grid size-7 shrink-0 place-items-center rounded-full border text-[13px] font-semibold', s.done ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-line-strong text-ink-600')}>
                {s.done ? <CheckCircle2 className="size-4" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={clsx('block font-medium', s.done ? 'text-ink-500 line-through' : 'text-ink-900')}>{x.title}</span>
                {x.body && !s.done && <span className="block text-[12.5px] text-ink-500" data-testid={`step-${s.key}-body`}>{x.body}</span>}
              </span>
              {!s.done && x.action}
            </li>
          );
        })}
      </ol>
      {karats && <KaratsDialog current={status.allowedKarats} onClose={() => setKarats(false)} />}
    </Panel>
    </div>
  );
}

function KaratsDialog({ current, onClose }: { current: number[]; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const [picked, setPicked] = useState<number[]>(current);
  const options = [...new Set([...KARATS, ...current])].sort((a, b) => a - b);
  const m = useMutation({
    mutationFn: () => post<SetupStatus>('/setup/allowed-karats', { allowedKarats: picked }),
    onSuccess: async () => {
      toast.success(t('Allowed karats confirmed'));
      await qc.invalidateQueries({ queryKey: ['setup-status'] });
      await refresh();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Which karats do you sell?')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!picked.length} loading={m.isPending} onClick={() => m.mutate()} data-testid="confirm-karats">{t('Confirm')}</Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        {options.map((k) => (
          <label key={k} className={clsx('flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-[13px]', picked.includes(k) ? 'border-ink-900 bg-canvas font-medium' : 'border-line')}>
            <input
              type="checkbox"
              className="size-4 accent-gold-600"
              checked={picked.includes(k)}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, k] : p.filter((x) => x !== k)))}
              data-testid={`karat-${k}`}
            />
            {karatLabel(k)}
          </label>
        ))}
      </div>
    </Dialog>
  );
}
