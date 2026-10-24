// MIS-1: the dialog of every mistake correction of the General Manager (void a scrap purchase, correct a supplier
// order). It always asks for the reason (3–200 characters, the server's own rule from @jerp/shared) and the password;
// the caller adds the fields of its correction above them and says when they are valid. Save stays grey until all are.

import { useEffect, useState, type ReactNode } from 'react';
import { CHANGE_REASON_MAX, CHANGE_REASON_MIN, correctionReason } from '@jerp/shared';
import { useI18n } from '../lib/i18n';
import { Alert, Button, Dialog, Field, Input, Textarea } from './ui';

export interface Confirmation {
  reason: string;
  confirmPassword: string;
}

export function CorrectionDialog({
  open,
  title,
  subtitle,
  children,
  valid = true,
  error,
  confirmLabel,
  danger,
  loading,
  onCancel,
  onConfirm,
  testId,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  /** The caller's own fields are valid. */
  valid?: boolean;
  /** The server's refusal, shown in the dialog (it stays open). */
  error?: string | null;
  confirmLabel: string;
  danger?: boolean;
  loading: boolean;
  onCancel: () => void;
  onConfirm: (c: Confirmation) => void;
  testId: string;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (!open) {
      setReason('');
      setPassword('');
    }
  }, [open]);
  const trimmed = correctionReason(reason);
  const ok = valid && trimmed != null && password.length > 0;
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      size="sm"
      title={title}
      subtitle={subtitle}
      footer={
        <>
          <Button onClick={onCancel}>{t('Cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={!ok} loading={loading} onClick={() => trimmed && onConfirm({ reason: trimmed, confirmPassword: password })} data-testid={`${testId}-confirm`}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid={testId}>
        {children}
        <Field label={t('Reason')} hint={t('{min} to {max} characters. Kept in the audit log.', { min: CHANGE_REASON_MIN, max: CHANGE_REASON_MAX })}>
          <Textarea rows={2} value={reason} maxLength={CHANGE_REASON_MAX + 20} onChange={(e) => setReason(e.target.value)} invalid={reason.trim().length > CHANGE_REASON_MAX} data-testid={`${testId}-reason`} />
        </Field>
        <Field label={t('Your password')}>
          <Input type="password" autoComplete="current-password" value={password} maxLength={128} onChange={(e) => setPassword(e.target.value)} data-testid={`${testId}-password`} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
