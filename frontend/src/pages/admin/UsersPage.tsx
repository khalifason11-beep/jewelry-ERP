import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Pencil, Power, ShieldCheck, UserPlus } from 'lucide-react';
import { get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateTime, relative } from '../../lib/format';
import { useBranches } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { Alert, Badge, Button, Card, Dialog, ErrorState, Field, Input, Loading, Mono, PageHeader, Select, StatusBadge } from '../../components/ui';
import { DataTable } from '../../components/ui/DataTable';

interface UserRow {
  id: number;
  username: string;
  fullName: string;
  fullNameAr: string | null;
  phone: string | null;
  roleCode: string;
  roleName: string;
  roleRank: number;
  branchId: number | null;
  branchName: string | null;
  status: string;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  activeSessions: number;
}
interface Role {
  id: number;
  code: string;
  name: string;
  rank: number;
  permissions: string[];
}

export function UsersPage() {
  const { t, lang } = useI18n();
  const { can, me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<UserRow[]>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<Role[]>('/roles') });
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [confirm, setConfirm] = useState<{ user: UserRow; action: 'reset' | 'disable' | 'enable' } | null>(null);
  const [secret, setSecret] = useState<{ username: string; temporaryPassword: string } | null>(null);
  const manage = can('users.manage');

  const act = useMutation({
    mutationFn: async ({ user, action }: { user: UserRow; action: 'reset' | 'disable' | 'enable' }) => {
      if (action === 'reset') return post<{ username: string; temporaryPassword: string }>(`/users/${user.id}/reset-password`);
      return post(`/users/${user.id}/${action}`);
    },
    onSuccess: (res, v) => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['users'] });
      if (v.action === 'reset') setSecret(res as { username: string; temporaryPassword: string });
      else
        toast.success(
          v.action === 'disable' ? t('{user} disabled', { user: v.user.username }) : t('{user} enabled', { user: v.user.username }),
          v.action === 'disable' ? t('All active sessions were terminated.') : undefined,
        );
    },
    onError: (e) => toast.fromError(e),
  });

  return (
    <div className="p-5 lg:p-6">
      <PageHeader
        title={t('Users')}
        subtitle={t('Accounts, roles and branch assignments. Passwords are managed centrally: they can be reset, never viewed.')}
        actions={manage && <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setEditing('new')}>{t('New user')}</Button>}
      />
      <Card padded={false}>
        {users.isLoading ? (
          <Loading />
        ) : users.isError ? (
          <ErrorState error={users.error} />
        ) : (
          <DataTable
            rows={users.data!}
            rowKey={(r) => r.id}
            exportName="users"
            columns={[
              {
                key: 'fullName',
                header: t('User'),
                render: (r) => (
                  <div>
                    <div className="font-medium">{r.fullName} {r.id === me?.user.id && <Badge className="ms-1">{t('you')}</Badge>}</div>
                    <div className="font-mono text-[11.5px] text-ink-500">{r.username}</div>
                  </div>
                ),
              },
              { key: 'roleName', header: t('Role'), render: (r) => <span className="inline-flex items-center gap-1.5">{r.roleCode === 'GENERAL_MANAGER' && <ShieldCheck className="size-3.5 text-gold-600" />}{t(r.roleName)}</span> },
              { key: 'branchName', header: t('Branch'), render: (r) => (r.branchName ? t(r.branchName) : null) ?? <span className="text-ink-500">{t('All branches')}</span> },
              { key: 'lastLoginAt', header: t('Last sign-in'), render: (r) => <span title={dateTime(r.lastLoginAt, lang)}>{relative(r.lastLoginAt)}</span> },
              { key: 'activeSessions', header: t('Live sessions'), align: 'end', render: (r) => (Number(r.activeSessions) > 0 ? <span className="font-medium text-emerald-700 num">{r.activeSessions}</span> : <span className="text-ink-400">0</span>) },
              { key: 'password', header: t('Password'), sortable: false, value: (r) => (r.mustChangePassword ? t('Must change') : t('Set')), render: (r) => (r.mustChangePassword ? <Badge tone="bg-amber-50 text-amber-800 ring-amber-600/25">{t('Must change')}</Badge> : <span className="text-[12px] text-ink-500">{t('Set {when}', { when: relative(r.passwordChangedAt) })}</span>) },
              { key: 'status', header: t('Status'), render: (r) => <StatusBadge status={r.status} /> },
              ...(manage
                ? [
                    {
                      key: 'actions',
                      header: t('Actions'),
                      sortable: false,
                      align: 'end' as const,
                      render: (r: UserRow) => (
                        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(r)} aria-label={t('Edit')}><Pencil className="size-4" /></Button>
                          <Button size="sm" variant="ghost" icon={<KeyRound className="size-4" />} onClick={() => setConfirm({ user: r, action: 'reset' })}>{t('Reset')}</Button>
                          {r.id !== me?.user.id && (
                            <Button size="sm" variant="ghost" className={r.status === 'ACTIVE' ? 'text-rose-700' : 'text-emerald-700'} icon={<Power className="size-4" />} onClick={() => setConfirm({ user: r, action: r.status === 'ACTIVE' ? 'disable' : 'enable' })}>
                              {r.status === 'ACTIVE' ? t('Disable') : t('Enable')}
                            </Button>
                          )}
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Card>

      {roles.data && (
        <Card padded={false} className="mt-5">
          <div className="border-b border-line px-5 py-3.5">
            <h3 className="text-[15px] font-semibold">{t('Roles & permissions')}</h3>
            <p className="text-[13px] text-ink-500">{t('Roles are data, not code. New roles can be added without a release.')}</p>
          </div>
          <div className="grid gap-4 p-5 lg:grid-cols-3">
            {roles.data.map((r) => (
              <div key={r.id} className="rounded-md border border-line p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold">{t(r.name)}</span>
                  <span className="text-[11.5px] text-ink-500">{t('{n} permissions', { n: r.permissions.length })}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {r.permissions.map((p) => <Mono key={p} className="rounded bg-canvas px-1.5 py-0.5 text-[11px] text-ink-600">{p}</Mono>)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {editing && <UserDialog user={editing === 'new' ? null : editing} roles={roles.data ?? []} onClose={() => setEditing(null)} onCreated={(s) => setSecret(s)} />}

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={
          confirm?.action === 'reset'
            ? t('Reset password for {user}?', { user: confirm.user.username })
            : confirm?.action === 'disable'
              ? t('Disable {user}?', { user: confirm?.user.username ?? '' })
              : t('Enable {user}?', { user: confirm?.user.username ?? '' })
        }
        subtitle={
          confirm?.action === 'reset'
            ? t('A one-time temporary password will be generated. The user must choose a new password at next sign-in. Current sessions end immediately.')
            : confirm?.action === 'disable'
              ? t('The user cannot sign in until re-enabled. All their active sessions end immediately.')
              : t('The user will be able to sign in again.')
        }
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>{t('Cancel')}</Button>
            <Button variant={confirm?.action === 'disable' ? 'danger' : 'primary'} loading={act.isPending} onClick={() => confirm && act.mutate(confirm)}>{t('Confirm')}</Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-600">{t('This action is recorded in the audit log.')}</p>
      </Dialog>

      <Dialog open={!!secret} onClose={() => setSecret(null)} title={t('Temporary password')} subtitle={t('For {user}. Shown only once. Hand it to the user securely.', { user: secret?.username ?? '' })} footer={<Button variant="primary" onClick={() => setSecret(null)}>{t('Done')}</Button>}>
        <div className="flex items-center gap-2 rounded-md border border-gold-400 bg-gold-50 px-4 py-3">
          <Mono className="flex-1 text-lg tracking-wider">{secret?.temporaryPassword}</Mono>
          <Button size="sm" icon={<Copy className="size-4" />} onClick={() => { navigator.clipboard?.writeText(secret?.temporaryPassword ?? ''); toast.info(t('Copied')); }}>{t('Copy')}</Button>
        </div>
        <Alert tone="info" className="mt-3">{t('The system stores only a salted hash. Nobody, including the General Manager, can see this password again.')}</Alert>
      </Dialog>
    </div>
  );
}

function UserDialog({ user, roles, onClose, onCreated }: { user: UserRow | null; roles: Role[]; onClose: () => void; onCreated: (s: { username: string; temporaryPassword: string }) => void }) {
  const { t, L } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const branches = useBranches();
  const [f, setF] = useState({
    username: user?.username ?? '',
    fullName: user?.fullName ?? '',
    fullNameAr: user?.fullNameAr ?? '',
    phone: user?.phone ?? '',
    roleCode: user?.roleCode ?? 'CASHIER',
    branchId: user?.branchId ?? ('' as number | ''),
    temporaryPassword: '',
  });
  const role = roles.find((r) => r.code === f.roleCode);
  const global = role?.permissions.includes('scope.all_branches');
  const m = useMutation({
    mutationFn: () =>
      user
        ? patch(`/users/${user.id}`, { fullName: f.fullName, fullNameAr: f.fullNameAr, phone: f.phone, roleCode: f.roleCode, branchId: global ? null : f.branchId || null })
        : post<{ username: string; temporaryPassword: string }>('/users', { ...f, branchId: global ? null : f.branchId || null, temporaryPassword: f.temporaryPassword || undefined }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
      if (user) toast.success(t('User updated'));
      else onCreated(res as { username: string; temporaryPassword: string });
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={user ? t('Edit {user}', { user: user.username }) : t('New user')}
      subtitle={user ? t('Changing the role or branch ends the user’s active sessions.') : t('The user must set a personal password at first sign-in.')}
      footer={<><Button onClick={onClose}>{t('Cancel')}</Button><Button variant="primary" loading={m.isPending} disabled={!f.fullName || (!user && !f.username) || (!global && !f.branchId)} onClick={() => m.mutate()}>{user ? t('Save') : t('Create user')}</Button></>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Username')} hint={!user ? t('e.g. cashier.kh.03') : undefined}>
          <Input value={f.username} disabled={!!user} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} className="font-mono" />
        </Field>
        <Field label={t('Full name')}>
          <Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        </Field>
        <Field label={t('Full name (Arabic)')}>
          <Input dir="rtl" value={f.fullNameAr} onChange={(e) => setF({ ...f, fullNameAr: e.target.value })} />
        </Field>
        <Field label={t('Phone')}>
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label={t('Role')}>
          <Select value={f.roleCode} onChange={(e) => setF({ ...f, roleCode: e.target.value })}>
            {roles.map((r) => <option key={r.code} value={r.code}>{t(r.name)}</option>)}
          </Select>
        </Field>
        <Field label={t('Branch')}>
          <Select value={global ? '' : f.branchId} disabled={global} onChange={(e) => setF({ ...f, branchId: e.target.value ? Number(e.target.value) : '' })}>
            <option value="">{global ? t('All branches') : t('Select…')}</option>
            {branches.data?.map((b) => <option key={b.id} value={b.id}>{L(b.name, b.nameAr)}</option>)}
          </Select>
        </Field>
        {!user && (
          <Field label={t('Temporary password')} hint={t('Leave empty to generate a secure one')} className="sm:col-span-2">
            <Input value={f.temporaryPassword} onChange={(e) => setF({ ...f, temporaryPassword: e.target.value })} autoComplete="new-password" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
