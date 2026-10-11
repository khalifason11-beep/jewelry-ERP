// Development-only kitchen sink (UI-A1): every component of the design system in every state, with static sample
// text in Arabic and English. Registered only when `import.meta.env.DEV` (never in the production bundle); photographed
// by scripts/capture-ui-kit.mjs. The folder src/dev/ is outside the i18n check: these are samples, not product text.

import { useState } from 'react';
import { Inbox, Plus, Save, Trash2 } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  Empty,
  ErrorState,
  Field,
  Input,
  KeyValue,
  Kpi,
  Loading,
  PageHeader,
  Panel,
  PanelHeader,
  Pill,
  PillGroup,
  Select,
  SkeletonRows,
  StatusBadge,
  Table,
  TD,
  TH,
  THead,
  TR,
  Tabs,
  Textarea,
} from '../components/ui';
import { useI18n } from '../lib/i18n';
import { ApiError } from '../lib/api';
import { RefreshBar } from '../components/ui/QueryState';
import { PageErrorBoundary } from '../components/layout/PageErrorBoundary';
import { useToast } from '../lib/toast';

function Boom(): never {
  throw new Error('Kit crash demo');
}

/** The crash page inside a card: what a page shows when it fails to render (D-ui-12). */
function CrashDemo({ tx }: { tx: (en: string, ar: string) => string }) {
  const [crash, setCrash] = useState(false);
  return (
    <PageErrorBoundary home="/ui">
      {crash ? (
        <Boom />
      ) : (
        <div className="p-6 text-center">
          <Button variant="secondary" onClick={() => setCrash(true)} data-testid="kit-crash">
            {tx('Simulate a page crash', 'محاكاة تعطل صفحة')}
          </Button>
        </div>
      )}
    </PageErrorBoundary>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} data-kit={id} className="mb-8">
      <h2 className="mb-3 text-section font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

const SWATCHES = ['navy', 'navy-2', 'navy-3', 'gold', 'gold-soft', 'ink', 'ink-2', 'ink-3', 'surface', 'panel', 'neutral-bg', 'line', 'crit', 'crit-bg', 'warn', 'warn-bg', 'ok', 'ok-bg', 'b1', 'b2', 'b3', 'b4'];

export default function UiKitPage() {
  const { lang, setLang } = useI18n();
  const tx = (en: string, ar: string) => (lang === 'ar' ? ar : en);
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today');
  const [tab, setTab] = useState<'a' | 'b'>('a');

  return (
    <div className="mx-auto max-w-[1180px] p-4 text-ink" data-testid="ui-kit">
      <div className="mb-6 flex items-center justify-between">
        <PageHeader title={tx('Design system', 'نظام التصميم')} subtitle={tx('UI-A1 · development only · sample data', 'UI-A1 · للتطوير فقط · بيانات تجريبية')} />
        <Pill onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} data-testid="kit-lang">
          {lang === 'ar' ? 'English' : 'العربية'}
        </Pill>
      </div>

      <Section id="tokens" title={tx('Colour tokens', 'ألوان النظام')}>
        <div className="grid grid-cols-6 gap-2 sm:grid-cols-11">
          {SWATCHES.map((s) => (
            <div key={s} className="text-meta text-ink-3">
              <div className="mb-1 h-10 rounded-row border border-line" style={{ background: `var(--color-${s})` }} />
              <span dir="ltr">{s}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 space-y-1">
          <div className="text-kpi font-semibold num">5,383,000</div>
          <div className="text-title font-semibold">{tx('Page title · 20', 'عنوان الصفحة · 20')}</div>
          <div className="text-section font-semibold">{tx('Section title · 17', 'عنوان القسم · 17')}</div>
          <div className="text-[15px]">{tx('Body text and table cells · 15', 'نص أساسي وخلايا الجداول · 15')}</div>
          <div className="text-meta text-ink-3">{tx('Meta, hints and table headers · 13', 'بيانات ثانوية وتلميحات وعناوين الجداول · 13')}</div>
        </div>
      </Section>

      <Section id="buttons" title={tx('Buttons', 'الأزرار')}>
        <div className="space-y-3">
          {(['primary', 'secondary', 'ghost', 'danger', 'danger-solid'] as const).map((v) => (
            <div key={v} className="flex flex-wrap items-center gap-3" data-kit-row={v}>
              <span className="w-28 text-meta text-ink-3" dir="ltr">
                {v}
              </span>
              <Button variant={v} icon={v.startsWith('danger') ? <Trash2 className="size-4" /> : <Save className="size-4" />} data-testid={`kit-btn-${v}`}>
                {v.startsWith('danger') ? tx('Delete', 'حذف') : tx('Save', 'حفظ')}
              </Button>
              <Button variant={v} disabled>
                {tx('Disabled', 'غير متاح')}
              </Button>
              <Button variant={v} loading data-testid={`kit-btn-${v}-loading`}>
                {tx('Saving…', 'جارٍ الحفظ…')}
              </Button>
              <Button variant={v} size="sm">
                {tx('Small', 'صغير')}
              </Button>
              <Button variant={v} size="lg">
                {tx('Large', 'كبير')}
              </Button>
            </div>
          ))}
        </div>
      </Section>

      <Section id="inputs" title={tx('Inputs', 'الحقول')}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={tx('Branch name', 'اسم الفرع')} hint={tx('2 characters at least', 'حرفان على الأقل')}>
            <Input placeholder={tx('e.g. Khartoum', 'مثلاً: الخرطوم')} data-testid="kit-input" />
          </Field>
          <Field label={tx('Code', 'الرمز')} error={tx('2–6 capital letters', 'من 2 إلى 6 أحرف لاتينية كبيرة')} required>
            <Input defaultValue="k1" data-testid="kit-input-invalid" />
          </Field>
          <Field label={tx('Disabled', 'غير متاح')}>
            <Input defaultValue={tx('Cannot be changed', 'لا يمكن تغييره')} disabled />
          </Field>
          <Field label={tx('Read only', 'للقراءة فقط')}>
            <Input defaultValue="KRT" readOnly />
          </Field>
          <Field label={tx('Karat', 'العيار')}>
            <Select defaultValue="21" data-testid="kit-select">
              <option value="18">18</option>
              <option value="21">21</option>
            </Select>
          </Field>
          <Field label={tx('Note', 'ملاحظة')}>
            <Textarea placeholder={tx('Optional', 'اختياري')} />
          </Field>
        </div>
      </Section>

      <Section id="badges" title={tx('Status badges', 'شارات الحالة')}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="crit">{tx('Urgent', 'عاجل')}</Badge>
          <Badge tone="warn">{tx('Warning', 'تنبيه')}</Badge>
          <Badge tone="ok">{tx('Completed', 'مكتمل')}</Badge>
          <Badge tone="info">{tx('For information', 'للعلم')}</Badge>
          {['COMPLETED', 'IN_TRANSIT', 'VOIDED', 'AVAILABLE', 'SOLD'].map((s) => (
            <StatusBadge key={s} status={s} />
          ))}
        </div>
      </Section>

      <Section id="pills" title={tx('Pills and tabs', 'الأزرار الدائرية والتبويبات')}>
        <div className="flex flex-wrap items-center gap-4">
          <PillGroup
            label={tx('Period', 'الفترة')}
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'today', label: tx('Today', 'اليوم') },
              { value: 'week', label: tx('7 days', '7 أيام') },
              { value: 'month', label: tx('This month', 'هذا الشهر') },
            ]}
          />
          <Pill tone="dark">
            <span className="size-2 rounded-full bg-gold" />
            {tx('21K', 'عيار 21')} <b className="num">190,000</b>
          </Pill>
        </div>
        <Tabs
          className="mt-4"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'a', label: tx('Sales', 'المبيعات'), count: 12 },
            { value: 'b', label: tx('Inventory', 'المخزون') },
          ]}
        />
      </Section>

      <Section id="surfaces" title={tx('Panels, cards and figures', 'اللوحات والبطاقات والأرقام')}>
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel label={tx('Needs attention', 'يحتاج إلى متابعة')}>
            <PanelHeader title={tx('Needs attention', 'يحتاج إلى متابعة')} count={3} action={<a href="#tokens">{tx('View all', 'عرض الكل')}</a>} />
            <div className="mt-1.5 flex items-center gap-2.5 rounded-row bg-surface px-3 py-2">
              <Badge tone="warn">{tx('Warning', 'تنبيه')}</Badge>
              <span className="flex-1">{tx('Transfer waiting to be received', 'تحويل وارد بانتظار الاستلام')}</span>
            </div>
          </Panel>
          <Card padded={false}>
            <CardHeader title={tx('Card', 'بطاقة')} subtitle={tx('Flat grey surface', 'سطح رمادي مسطح')} />
            <div className="p-5">
              <KeyValue
                items={[
                  { label: tx('Branch', 'الفرع'), value: tx('Khartoum', 'الخرطوم') },
                  { label: tx('Pieces', 'القطع'), value: <span className="num">62</span> },
                ]}
              />
            </div>
          </Card>
          <div className="grid gap-3">
            <Kpi tone="dark" label={tx('Sales today', 'المبيعات اليوم')} value="5,383,000" sub={tx('12 invoices', '12 فاتورة')} />
            <Kpi label={tx('Gold held', 'الذهب المملوك')} value="2,737.160" sub={tx('grams', 'جم')} />
          </div>
        </div>
      </Section>

      <Section id="table" title={tx('Table', 'الجدول')}>
        <Card padded={false} className="bg-surface">
          <Table>
            <THead>
              <tr>
                <TH>{tx('Code', 'الرمز')}</TH>
                <TH>{tx('Product', 'المنتج')}</TH>
                <TH>{tx('Status', 'الحالة')}</TH>
                <TH numeric>{tx('Weight (g)', 'الوزن (جم)')}</TH>
                <TH numeric>{tx('Price', 'السعر')}</TH>
              </tr>
            </THead>
            <tbody>
              {[
                ['J-1369', tx('Necklace', 'عقد'), 'AVAILABLE', '12.180', '2,750,000'],
                ['J-1368', tx('Earrings', 'حلق'), 'SOLD', '3.080', '725,000'],
                ['J-1377', tx('Ring', 'خاتم'), 'IN_TRANSIT', '4.010', '990,000'],
              ].map((r) => (
                <TR key={r[0]}>
                  <TD className="font-mono text-meta">{r[0]}</TD>
                  <TD>{r[1]}</TD>
                  <TD>
                    <StatusBadge status={r[2]} />
                  </TD>
                  <TD numeric>{r[3]}</TD>
                  <TD numeric>{r[4]}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      </Section>

      <Section id="states" title={tx('States', 'الحالات')}>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <Empty
              title={tx('No pieces in this branch yet', 'لا توجد قطع في هذا الفرع بعد')}
              body={tx('Receive a supplier order to start.', 'استلم طلبية مورد للبدء.')}
              icon={<Inbox className="size-5" />}
              action={
                <Button variant="primary" icon={<Plus className="size-4" />}>
                  {tx('New purchase', 'مشتريات جديدة')}
                </Button>
              }
            />
          </Card>
          <Card>
            <Empty variant="no-access" title={tx('You do not have access to this page', 'ليست لديك صلاحية لهذه الصفحة')} />
          </Card>
          <Card>
            <ErrorState error={new Error(tx('The server did not answer.', 'لم يستجب الخادم.'))} onRetry={() => undefined} />
          </Card>
          <Card>
            <Loading />
          </Card>
          <Card className="lg:col-span-2">
            <SkeletonRows rows={4} />
          </Card>
          <Card>
            <Empty variant="prompt" title={tx('Choose a branch to see its cash', 'اختر فرعاً لعرض نقديته')} body={tx('Use the branch selector above.', 'استخدم اختيار الفرع في الأعلى.')} />
          </Card>
          <Card>
            <Empty variant="not-found" title={tx('This sale does not exist', 'هذا البيع غير موجود')} action={<Button size="sm">{tx('Back to the list', 'العودة إلى القائمة')}</Button>} />
          </Card>
          <Card>
            <ErrorState error={new ApiError(403, 'FORBIDDEN', 'Missing permission')} onRetry={() => undefined} />
          </Card>
          <Card className="lg:col-span-2">
            <div className="p-4 text-meta text-ink-3">{tx('A filter changed: the rows stay, a thin bar runs on top.', 'تغيّر عامل التصفية: تبقى الصفوف ويظهر شريط رفيع في الأعلى.')}</div>
            <RefreshBar active />
          </Card>
          <Card>
            <CrashDemo tx={tx} />
          </Card>
        </div>
        <div className="mt-4 grid gap-2 lg:grid-cols-2">
          <Alert tone="info" title={tx('For information', 'للعلم')}>
            {tx('Rates are set by the General Manager.', 'يحدد المدير العام الأسعار.')}
          </Alert>
          <Alert tone="warning" title={tx('Warning', 'تنبيه')}>
            {tx('A transfer is waiting for 30 hours.', 'تحويل ينتظر منذ 30 ساعة.')}
          </Alert>
          <Alert tone="danger" title={tx('Urgent', 'عاجل')}>
            {tx('Cash count difference yesterday.', 'فرق في عدّ النقدية أمس.')}
          </Alert>
          <Alert tone="success" title={tx('Completed', 'مكتمل')}>
            {tx('The sale was recorded.', 'تم تسجيل البيع.')}
          </Alert>
        </div>
      </Section>

      <Section id="feedback" title={tx('Toasts and dialogs', 'الإشعارات والنوافذ')}>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => toast.success(tx('Branch created', 'تم إنشاء الفرع'), tx('Recorded in the audit log.', 'سُجل في سجل التدقيق.'))} data-testid="kit-toast-success">
            {tx('Success toast', 'إشعار نجاح')}
          </Button>
          <Button onClick={() => toast.error(tx('Could not save', 'تعذّر الحفظ'), tx('Check the highlighted fields.', 'راجع الحقول المحددة.'))} data-testid="kit-toast-error">
            {tx('Error toast', 'إشعار خطأ')}
          </Button>
          <Button onClick={() => toast.info(tx('Sale held', 'تم تعليق البيع'))} data-testid="kit-toast-info">
            {tx('Info toast', 'إشعار معلومة')}
          </Button>
          <Button variant="primary" onClick={() => setDialog(true)} data-testid="kit-open-dialog">
            {tx('Open dialog', 'فتح نافذة')}
          </Button>
        </div>
      </Section>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title={tx('New branch', 'فرع جديد')}
        subtitle={tx('Recorded in the audit log', 'يُسجل في سجل التدقيق')}
        footer={
          <>
            <Button onClick={() => setDialog(false)}>{tx('Cancel', 'إلغاء')}</Button>
            <Button variant="danger" onClick={() => setConfirm(true)} data-testid="kit-dialog-delete">
              {tx('Delete…', 'حذف…')}
            </Button>
            <Button variant="primary" data-testid="kit-dialog-save">
              {tx('Save', 'حفظ')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx('Code', 'الرمز')}>
            <Input data-testid="kit-dialog-code" />
          </Field>
          <Field label={tx('Name', 'الاسم')}>
            <Input data-testid="kit-dialog-name" />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        size="sm"
        title={tx('Delete this branch?', 'حذف هذا الفرع؟')}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{tx('Keep it', 'إبقاؤه')}</Button>
            <Button variant="danger-solid" data-autofocus onClick={() => setConfirm(false)} data-testid="kit-confirm-delete">
              {tx('Yes, delete', 'نعم، احذف')}
            </Button>
          </>
        }
      >
        <p className="text-ink-2">{tx('This cannot be undone.', 'لا يمكن التراجع عن هذا.')}</p>
      </Dialog>
    </div>
  );
}
