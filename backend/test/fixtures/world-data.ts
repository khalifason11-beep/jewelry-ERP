// TEST FIXTURE (REM-3): static data of the test world (products, people, places). People, suppliers and the company are
// marked placeholders ([Test] / [اختبار], CLN-1) so nothing resembles a real person or client; branches keep city names.

/** Branding of the demo deployment (production branding is entered by the GM in Settings). */
export const COMPANY = {
  name: '[Test] Gold Jewelry',
  nameAr: '[اختبار] مجوهرات الذهب',
  invoiceFooter: 'Thank you for shopping with us',
  invoiceFooterAr: 'شكراً لتسوقكم معنا',
};

export const BRANCHES = [
  { code: 'KRT', name: 'Khartoum Branch', nameAr: 'فرع الخرطوم', city: 'Khartoum', address: 'شارع القصر، سوق الذهب، الخرطوم', phone: '+249 183 000 101' },
  { code: 'OMD', name: 'Omdurman Branch', nameAr: 'فرع أم درمان', city: 'Omdurman', address: 'سوق أم درمان، زقاق الذهب 4', phone: '+249 187 000 202' },
  { code: 'BHR', name: 'Bahri Branch', nameAr: 'فرع بحري', city: 'Khartoum North', address: 'المؤسسة، الشارع الرئيسي', phone: '+249 185 000 303' },
  { code: 'PZU', name: 'Port Sudan Branch', nameAr: 'فرع بورتسودان', city: 'Port Sudan', address: 'السوق الكبير، مربع 2', phone: '+249 311 000 404' },
] as const;

export const DEMO_PASSWORDS = {
  GENERAL_MANAGER: 'demo-gm-2026',
  BRANCH_MANAGER: 'demo-bm-2026',
  CASHIER: 'demo-cashier-2026',
} as const;

export const USERS: { username: string; fullName: string; fullNameAr: string; role: keyof typeof DEMO_PASSWORDS; branch: string | null; phone: string }[] = [
  { username: 'general.manager', fullName: '[Test] General Manager', fullNameAr: '[اختبار] المدير العام', role: 'GENERAL_MANAGER', branch: null, phone: '+249 912 000 001' },
  { username: 'branch.manager.kh', fullName: '[Test] Branch Manager KRT', fullNameAr: '[اختبار] مدير فرع KRT', role: 'BRANCH_MANAGER', branch: 'KRT', phone: '+249 912 000 011' },
  { username: 'cashier.kh.01', fullName: '[Test] Cashier KRT 01', fullNameAr: '[اختبار] كاشير KRT 01', role: 'CASHIER', branch: 'KRT', phone: '+249 912 000 012' },
  { username: 'cashier.kh.02', fullName: '[Test] Cashier KRT 02', fullNameAr: '[اختبار] كاشير KRT 02', role: 'CASHIER', branch: 'KRT', phone: '+249 912 000 013' },
  { username: 'branch.manager.omd', fullName: '[Test] Branch Manager OMD', fullNameAr: '[اختبار] مدير فرع OMD', role: 'BRANCH_MANAGER', branch: 'OMD', phone: '+249 912 000 021' },
  { username: 'cashier.omd.01', fullName: '[Test] Cashier OMD 01', fullNameAr: '[اختبار] كاشير OMD 01', role: 'CASHIER', branch: 'OMD', phone: '+249 912 000 022' },
  { username: 'branch.manager.bhr', fullName: '[Test] Branch Manager BHR', fullNameAr: '[اختبار] مدير فرع BHR', role: 'BRANCH_MANAGER', branch: 'BHR', phone: '+249 912 000 031' },
  { username: 'cashier.bhr.01', fullName: '[Test] Cashier BHR 01', fullNameAr: '[اختبار] كاشير BHR 01', role: 'CASHIER', branch: 'BHR', phone: '+249 912 000 032' },
  { username: 'branch.manager.pzu', fullName: '[Test] Branch Manager PZU', fullNameAr: '[اختبار] مدير فرع PZU', role: 'BRANCH_MANAGER', branch: 'PZU', phone: '+249 912 000 041' },
  { username: 'cashier.pzu.01', fullName: '[Test] Cashier PZU 01', fullNameAr: '[اختبار] كاشير PZU 01', role: 'CASHIER', branch: 'PZU', phone: '+249 912 000 042' },
];

export const CATEGORIES = [
  { code: 'RING', name: 'Rings', nameAr: 'خواتم', weight: [2.4, 8.5] },
  { code: 'BRACELET', name: 'Bracelets', nameAr: 'أساور', weight: [7.5, 26] },
  { code: 'NECKLACE', name: 'Necklaces', nameAr: 'قلائد', weight: [9, 34] },
  { code: 'EARRING', name: 'Earrings', nameAr: 'أقراط', weight: [2.2, 7.5] },
  { code: 'CHAIN', name: 'Chains', nameAr: 'سلاسل', weight: [4.5, 21] },
  { code: 'PENDANT', name: 'Pendants', nameAr: 'تعاليق', weight: [1.6, 6.5] },
  { code: 'SET', name: 'Sets', nameAr: 'أطقم', weight: [26, 62] },
] as const;

/** The demo client sells 21K only (D-4-1): every product is 21K. */
export const PRODUCTS: { sku: string; name: string; nameAr: string; category: string; karat: number }[] = [
  { sku: 'RG-21-001', name: 'Gold Ring', nameAr: 'خاتم ذهب', category: 'RING', karat: 21 },
  { sku: 'RG-21-002', name: 'Twisted Band Ring', nameAr: 'خاتم مبروم', category: 'RING', karat: 21 },
  { sku: 'RG-21-003', name: 'Solitaire Ring', nameAr: 'خاتم سوليتير', category: 'RING', karat: 21 },
  { sku: 'RG-21-004', name: 'Engraved Wedding Band', nameAr: 'دبلة زواج منقوشة', category: 'RING', karat: 21 },
  { sku: 'RG-21-005', name: 'Cluster Stone Ring', nameAr: 'خاتم فصوص', category: 'RING', karat: 21 },
  { sku: 'RG-21-006', name: 'Signet Ring', nameAr: 'خاتم رجالي', category: 'RING', karat: 21 },
  { sku: 'BR-21-001', name: 'Classic Bangle', nameAr: 'غويشة كلاسيك', category: 'BRACELET', karat: 21 },
  { sku: 'BR-21-002', name: 'Sudanese Hollow Bangle', nameAr: 'غويشة سودانية مفرغة', category: 'BRACELET', karat: 21 },
  { sku: 'BR-21-003', name: 'Cuban Link Bracelet', nameAr: 'أسورة كوبية', category: 'BRACELET', karat: 21 },
  { sku: 'BR-21-004', name: 'Tennis Bracelet', nameAr: 'أسورة تنس', category: 'BRACELET', karat: 21 },
  { sku: 'BR-21-005', name: 'Charm Bracelet', nameAr: 'أسورة دلايات', category: 'BRACELET', karat: 21 },
  { sku: 'NK-21-001', name: 'Filigree Necklace', nameAr: 'عقد مشغول', category: 'NECKLACE', karat: 21 },
  { sku: 'NK-21-002', name: 'Pearl Drop Necklace', nameAr: 'عقد لؤلؤ', category: 'NECKLACE', karat: 21 },
  { sku: 'NK-21-003', name: 'Coin Necklace (Jinaih)', nameAr: 'عقد جنيهات', category: 'NECKLACE', karat: 21 },
  { sku: 'NK-21-004', name: 'Layered Necklace', nameAr: 'عقد طبقات', category: 'NECKLACE', karat: 21 },
  { sku: 'ER-21-001', name: 'Hoop Earrings', nameAr: 'حلق دائري', category: 'EARRING', karat: 21 },
  { sku: 'ER-21-002', name: 'Stud Earrings', nameAr: 'حلق صغير', category: 'EARRING', karat: 21 },
  { sku: 'ER-21-003', name: 'Chandelier Earrings', nameAr: 'حلق ثريا', category: 'EARRING', karat: 21 },
  { sku: 'ER-21-004', name: 'Crescent Earrings', nameAr: 'حلق هلال', category: 'EARRING', karat: 21 },
  { sku: 'CH-21-001', name: 'Rope Chain', nameAr: 'سلسلة حبل', category: 'CHAIN', karat: 21 },
  { sku: 'CH-21-002', name: 'Box Chain', nameAr: 'سلسلة بوكس', category: 'CHAIN', karat: 21 },
  { sku: 'CH-21-003', name: 'Figaro Chain', nameAr: 'سلسلة فيجارو', category: 'CHAIN', karat: 21 },
  { sku: 'CH-21-004', name: 'Snake Chain', nameAr: 'سلسلة ثعبان', category: 'CHAIN', karat: 21 },
  { sku: 'PD-21-001', name: 'Heart Pendant', nameAr: 'تعليقة قلب', category: 'PENDANT', karat: 21 },
  { sku: 'PD-21-002', name: 'Ayat Al-Kursi Pendant', nameAr: 'تعليقة آية الكرسي', category: 'PENDANT', karat: 21 },
  { sku: 'PD-21-003', name: 'Gold Pound Pendant', nameAr: 'تعليقة جنيه ذهب', category: 'PENDANT', karat: 21 },
  { sku: 'PD-21-004', name: 'Initial Letter Pendant', nameAr: 'تعليقة حرف', category: 'PENDANT', karat: 21 },
  { sku: 'ST-21-001', name: 'Bridal Set', nameAr: 'طقم عروس', category: 'SET', karat: 21 },
  { sku: 'ST-21-002', name: 'Evening Set', nameAr: 'طقم سهرة', category: 'SET', karat: 21 },
];

export const SUPPLIERS = [
  { name: '[Test] Supplier A', nameAr: '[اختبار] مورد أ', phone: '+249 912 300 100' },
  { name: '[Test] Supplier B', nameAr: '[اختبار] مورد ب', phone: '+249 912 300 200' },
  { name: '[Test] Supplier C', nameAr: '[اختبار] مورد ج', phone: '+971 4 000 0300' },
  { name: '[Test] Supplier D', nameAr: '[اختبار] مورد د', phone: '+90 212 000 0400' },
];

/** Walk-in customers named on invoices: marked placeholders (CLN-1), with an Arabic spelling. */
export const CUSTOMER_NAMES: { en: string; ar: string }[] = [
  { en: '[Test] Customer 01', ar: '[اختبار] عميل 01' },
  { en: '[Test] Customer 02', ar: '[اختبار] عميل 02' },
  { en: '[Test] Customer 03', ar: '[اختبار] عميل 03' },
  { en: '[Test] Customer 04', ar: '[اختبار] عميل 04' },
  { en: '[Test] Customer 05', ar: '[اختبار] عميل 05' },
  { en: '[Test] Customer 06', ar: '[اختبار] عميل 06' },
  { en: '[Test] Customer 07', ar: '[اختبار] عميل 07' },
  { en: '[Test] Customer 08', ar: '[اختبار] عميل 08' },
  { en: '[Test] Customer 09', ar: '[اختبار] عميل 09' },
  { en: '[Test] Customer 10', ar: '[اختبار] عميل 10' },
  { en: '[Test] Customer 11', ar: '[اختبار] عميل 11' },
  { en: '[Test] Customer 12', ar: '[اختبار] عميل 12' },
  { en: '[Test] Customer 13', ar: '[اختبار] عميل 13' },
  { en: '[Test] Customer 14', ar: '[اختبار] عميل 14' },
  { en: '[Test] Customer 15', ar: '[اختبار] عميل 15' },
  { en: '[Test] Customer 16', ar: '[اختبار] عميل 16' },
  { en: '[Test] Customer 17', ar: '[اختبار] عميل 17' },
  { en: '[Test] Customer 18', ar: '[اختبار] عميل 18' },
  { en: '[Test] Customer 19', ar: '[اختبار] عميل 19' },
  { en: '[Test] Customer 20', ar: '[اختبار] عميل 20' },
];

