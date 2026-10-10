// First steps on an empty system (REM-3, docs/ux/ANALYSIS.md §8): four steps before the first sale, shown
// on the General Manager's home until every step is really done (the server derives each one from data).
// Restyled in UI-B as a home panel (mockup empty-gm-home.html); four steps, not the mockup's three (REM-3 added karats).

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

export interface SetupStatus {
  complete: boolean;
  steps: { key: 'karats' | 'rates' | 'branch' | 'staff'; done: boolean }[];
  allowedKarats: number[];
}

export function useSetupStatus(enabled = true) {
  return useQuery({ queryKey: ['setup-status'], queryFn: () => get<SetupStatus>('/setup/status'), enabled });
}

export function FirstSteps({ status }: { status: SetupStatus }) {
  const { t } = useI18n();
  const [karats, setKarats] = useState(false);
  const done = status.steps.filter((s) => s.done).length;
  const text: Record<SetupStatus['steps'][number]['key'], { title: string; body: string; action: React.ReactNode }> = {
    karats: {
      title: t('Confirm the karats you sell'),
      body: t('Only these karats can be bought from suppliers and sold. Scrap of any karat can still be bought.'),
      action: <Button size="sm" variant="primary" onClick={() => setKarats(true)} data-testid="step-karats-action">{t('Confirm karats')}</Button>,
    },
    rates: {
      title: t('Set today’s gold rate and the scrap rates'),
      body: t('The selling rate per gram is shown to cashiers; scrap rates are what branches pay customers.'),
      action: <Link to="/settings" className="text-[13px] font-medium text-gold-700 hover:underline">{t('Set rates')}</Link>,
    },
    branch: {
      title: t('Create the first branch'),
      body: t('Arabic name and city. Every branch starts with zero cash and zero bank.'),
      action: <Link to="/branches" className="text-[13px] font-medium text-gold-700 hover:underline">{t('New branch')}</Link>,
    },
    staff: {
      title: t('Add the branch manager and a cashier'),
      body: t('Each gets a temporary password to change at the first sign-in.'),
      action: <Link to="/users" className="text-[13px] font-medium text-gold-700 hover:underline">{t('New user')}</Link>,
    },
  };
  return (
    <div className="mb-4" data-testid="first-steps">
    <Panel label={t('First steps')}>
      <PanelHeader title={t('Welcome. Four steps before the first sale')} action={<span className="num">{t('{done} of {total} done', { done, total: status.steps.length })}</span>} />
      <div className="mx-1 mb-2 h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
        <div className="h-full bg-navy" style={{ width: `${(done / status.steps.length) * 100}%` }} />
      </div>
      <ol className="grid grid-cols-1 gap-1.5">
        {status.steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-4 rounded-row bg-surface px-3 py-2.5" data-testid={`step-${s.key}`} data-done={s.done ? 'true' : 'false'}>
            <span className={clsx('grid size-7 shrink-0 place-items-center rounded-full border text-[13px] font-semibold', s.done ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-line-strong text-ink-600')}>
              {s.done ? <CheckCircle2 className="size-4" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={clsx('block font-medium', s.done ? 'text-ink-500 line-through' : 'text-ink-900')}>{text[s.key].title}</span>
              <span className="block text-[12.5px] text-ink-500">{text[s.key].body}</span>
            </span>
            {!s.done && text[s.key].action}
          </li>
        ))}
      </ol>
      <div className="px-1 pt-3 text-meta text-ink-3">
        {t('Then the branch manager records the first supplier order (types and products can be created on the same screen), and selling can start.')}
      </div>
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
      subtitle={t('Pieces of these karats can be bought from suppliers and sold. You can change this later in Settings.')}
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
