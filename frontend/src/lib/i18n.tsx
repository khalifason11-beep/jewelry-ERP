// Lightweight localization: English source strings are the keys; Arabic is a dictionary.
// Switching language flips the document direction (RTL). Missing keys fall back to English,
// so the prototype stays usable while the full Arabic catalogue is completed.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'ar';

const AR: Record<string, string> = {
  // navigation & shell
  'Point of Sale': 'نقطة البيع',
  'Hasad Gold': 'حصاد الذهب',
  'Hasad Withdrawals': 'سحوبات حصاد',
  'HASAD GOLD WITHDRAWALS': 'سحوبات حصاد الذهب',
  'My Activity': 'نشاطي',
  Dashboard: 'لوحة التحكم',
  'Executive Overview': 'نظرة تنفيذية',
  Branches: 'الفروع',
  Branch: 'الفرع',
  Sales: 'المبيعات',
  Inventory: 'المخزون',
  Purchases: 'المشتريات',
  Expenses: 'المصروفات',
  Transfers: 'التحويلات',
  Reports: 'التقارير',
  Users: 'المستخدمون',
  'Active Users': 'المستخدمون النشطون',
  'Active Sessions': 'الجلسات النشطة',
  'Audit Log': 'سجل التدقيق',
  Settings: 'الإعدادات',
  'Hasad Simulator': 'محاكي حصاد',
  Operations: 'العمليات',
  Counter: 'الكاونتر',
  Management: 'الإدارة',
  Administration: 'إدارة النظام',
  'Sign out': 'تسجيل الخروج',
  'Sign in': 'تسجيل الدخول',
  Notifications: 'الإشعارات',
  'No notifications': 'لا توجد إشعارات',
  'Gold 21K': 'ذهب عيار ٢١',
  'All branches': 'كل الفروع',
  Today: 'اليوم',
  // common
  Search: 'بحث',
  Status: 'الحالة',
  Date: 'التاريخ',
  Time: 'الوقت',
  Total: 'الإجمالي',
  Subtotal: 'المجموع الفرعي',
  Discount: 'الخصم',
  Price: 'السعر',
  Weight: 'الوزن',
  'Net weight': 'الوزن الصافي',
  'Gross weight': 'الوزن القائم',
  Karat: 'العيار',
  Category: 'الفئة',
  Item: 'القطعة',
  Items: 'القطع',
  Customer: 'العميل',
  Cashier: 'الكاشير',
  Cancel: 'إلغاء',
  Confirm: 'تأكيد',
  Save: 'حفظ',
  Close: 'إغلاق',
  Back: 'رجوع',
  Print: 'طباعة',
  Hold: 'تعليق',
  Export: 'تصدير',
  'Export CSV': 'تصدير CSV',
  Refresh: 'تحديث',
  All: 'الكل',
  From: 'من',
  To: 'إلى',
  Description: 'الوصف',
  Amount: 'المبلغ',
  Actions: 'إجراءات',
  User: 'المستخدم',
  Role: 'الدور',
  Available: 'متاح',
  Reserved: 'محجوز',
  'Loading…': 'جارٍ التحميل…',
  'Nothing to show': 'لا توجد بيانات',
  'Something went wrong': 'حدث خطأ',
  'Try again': 'حاول مرة أخرى',
  Payment: 'الدفع',
  'Payment method': 'طريقة الدفع',
  Invoice: 'فاتورة',
  // statuses
  AVAILABLE: 'متاح',
  RESERVED: 'محجوز',
  SOLD: 'مباع',
  REDEEMED: 'مُسلَّم (حصاد)',
  TRANSFERRED: 'قيد التحويل',
  DAMAGED: 'تالف',
  RETURNED: 'مرتجع',
  COMPLETED: 'مكتمل',
  VOIDED: 'ملغي',
  READY_FOR_PICKUP: 'جاهز للاستلام',
  IN_PROGRESS: 'قيد التنفيذ',
  CANCELLED: 'ملغي',
  APPROVED: 'معتمد',
  PENDING: 'بانتظار الموافقة',
  REJECTED: 'مرفوض',
  ACTIVE: 'نشط',
  IDLE: 'خامل',
  DISABLED: 'معطل',
  IN_TRANSIT: 'في الطريق',
  RECEIVED: 'مستلم',
  CASH: 'نقداً',
  BANK_TRANSFER: 'تحويل بنكي',
  CARD: 'بطاقة',
  MOBILE_WALLET: 'محفظة إلكترونية',
  BRANCH_PAYS_CUSTOMER: 'الفرع يدفع للعميل',
  CUSTOMER_PAYS_BRANCH: 'العميل يدفع للفرع',
  NONE: 'لا فرق',
  // categories
  Rings: 'خواتم',
  Bracelets: 'أساور',
  Necklaces: 'قلائد',
  Earrings: 'أقراط',
  Chains: 'سلاسل',
  Pendants: 'تعاليق',
  Sets: 'أطقم',
  // POS
  'Scan barcode or search by name, code…': 'امسح الباركود أو ابحث بالاسم أو الرمز…',
  'Current sale': 'البيع الحالي',
  'Cart is empty': 'السلة فارغة',
  'Scan or click a piece to add it.': 'امسح أو اضغط على قطعة لإضافتها.',
  'Complete Sale': 'إتمام البيع',
  'Customer name (optional)': 'اسم العميل (اختياري)',
  'Phone (optional)': 'الهاتف (اختياري)',
  'Held sales': 'المبيعات المعلقة',
  'Sale completed': 'تم البيع',
  'In cart': 'في السلة',
  // Hasad
  'Entitled weight': 'الوزن المستحق',
  'Delivered weight': 'الوزن المسلَّم',
  Difference: 'الفرق',
  Settlement: 'التسوية',
  'Customer arrived — open request': 'وصل العميل — فتح الطلب',
  'Waiting for customer': 'بانتظار العميل',
  'Customer at counter': 'العميل في الكاونتر',
  'Complete withdrawal': 'إتمام السحب',
  'Selected pieces': 'القطع المختارة',
  'Available pieces in this branch': 'القطع المتاحة في هذا الفرع',
  'Select for customer': 'اختيار للعميل',
  'Branch pays customer': 'الفرع يدفع للعميل',
  'Customer pays branch': 'العميل يدفع للفرع',
  'No inventory is reserved until the customer selects a piece.': 'لا يتم حجز أي قطعة حتى يختار العميل قطعة فعلية.',
  // dashboards
  "Today's Sales": 'مبيعات اليوم',
  "Today's Purchases": 'مشتريات اليوم',
  "Today's Expenses": 'مصروفات اليوم',
  'Gross Profit': 'إجمالي الربح',
  'Available Inventory': 'المخزون المتاح',
  'Inventory movement': 'حركة المخزون',
  'Opening stock': 'مخزون أول المدة',
  'Closing stock': 'مخزون آخر المدة',
  'Cashier activity': 'نشاط الكاشير',
  'Branch Performance': 'أداء الفروع',
  'Total Sales': 'إجمالي المبيعات',
  'Cost of Sales': 'تكلفة المبيعات',
  'Total Expenses': 'إجمالي المصروفات',
  'Net Contribution': 'صافي المساهمة',
  'Inventory Value': 'قيمة المخزون',
  'Hasad Redemptions': 'تسليمات حصاد',
};

interface I18n {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  setLang: (l: Lang) => void;
  t: (s: string) => string;
  /** Pick the localized field of a record (e.g. name / nameAr). */
  L: (en?: string | null, ar?: string | null) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      return (localStorage.getItem('jerp.lang') as Lang) || 'en';
    } catch {
      return 'en';
    }
  });
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('jerp.lang', l);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo<I18n>(
    () => ({
      lang,
      dir,
      setLang,
      t: (s) => (lang === 'ar' ? (AR[s] ?? s) : s),
      L: (en, ar) => (lang === 'ar' ? ar || en || '' : en || ar || ''),
    }),
    [lang, dir, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}
