// Static reference data for the demo (products, people, places). All names are fictional.

/** Branding of the demo deployment (production branding is entered by the GM in Settings). */
export const COMPANY = {
  name: 'Loai Tabeede',
  nameAr: 'لؤي تبيدي',
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
  { username: 'general.manager', fullName: 'Omer Abdelrahman', fullNameAr: 'عمر عبدالرحمن', role: 'GENERAL_MANAGER', branch: null, phone: '+249 912 000 001' },
  { username: 'branch.manager.kh', fullName: 'Hassan Elsayed', fullNameAr: 'حسن السيد', role: 'BRANCH_MANAGER', branch: 'KRT', phone: '+249 912 000 011' },
  { username: 'cashier.kh.01', fullName: 'Ahmed Ali', fullNameAr: 'أحمد علي', role: 'CASHIER', branch: 'KRT', phone: '+249 912 000 012' },
  { username: 'cashier.kh.02', fullName: 'Sara Mohamed', fullNameAr: 'سارة محمد', role: 'CASHIER', branch: 'KRT', phone: '+249 912 000 013' },
  { username: 'branch.manager.omd', fullName: 'Mustafa Ibrahim', fullNameAr: 'مصطفى إبراهيم', role: 'BRANCH_MANAGER', branch: 'OMD', phone: '+249 912 000 021' },
  { username: 'cashier.omd.01', fullName: 'Amna Yousif', fullNameAr: 'آمنة يوسف', role: 'CASHIER', branch: 'OMD', phone: '+249 912 000 022' },
  { username: 'branch.manager.bhr', fullName: 'Tarig Osman', fullNameAr: 'طارق عثمان', role: 'BRANCH_MANAGER', branch: 'BHR', phone: '+249 912 000 031' },
  { username: 'cashier.bhr.01', fullName: 'Hiba Salih', fullNameAr: 'هبة صالح', role: 'CASHIER', branch: 'BHR', phone: '+249 912 000 032' },
  { username: 'branch.manager.pzu', fullName: 'Adil Hamid', fullNameAr: 'عادل حامد', role: 'BRANCH_MANAGER', branch: 'PZU', phone: '+249 912 000 041' },
  { username: 'cashier.pzu.01', fullName: 'Nour Eldin Musa', fullNameAr: 'نور الدين موسى', role: 'CASHIER', branch: 'PZU', phone: '+249 912 000 042' },
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
  { name: 'Al-Sharif Gold Workshop', nameAr: 'ورشة الشريف للذهب', phone: '+249 912 300 100' },
  { name: 'Nile Goldsmiths Co.', nameAr: 'شركة النيل للصاغة', phone: '+249 912 300 200' },
  { name: 'Dubai Souk Gold Trading LLC', nameAr: 'دبي سوق الذهب للتجارة', phone: '+971 4 000 0300' },
  { name: 'Istanbul Kuyumculuk A.Ş.', nameAr: 'إسطنبول للمجوهرات', phone: '+90 212 000 0400' },
];

/** Walk-in customers named on invoices (fictional), with Arabic spelling. */
export const CUSTOMER_NAMES: { en: string; ar: string }[] = [
  { en: 'Mohamed Ahmed', ar: 'محمد أحمد' },
  { en: 'Fatima Osman', ar: 'فاطمة عثمان' },
  { en: 'Khalid Abdalla', ar: 'خالد عبدالله' },
  { en: 'Maha Elfadil', ar: 'مها الفاضل' },
  { en: 'Yasir Hamza', ar: 'ياسر حمزة' },
  { en: 'Rania Mahgoub', ar: 'رانيا محجوب' },
  { en: 'Ibrahim Nour', ar: 'إبراهيم نور' },
  { en: 'Samia Babiker', ar: 'سامية بابكر' },
  { en: 'Abubakr Siddig', ar: 'أبوبكر صديق' },
  { en: 'Huda Elamin', ar: 'هدى الأمين' },
  { en: 'Walid Karrar', ar: 'وليد كرار' },
  { en: 'Tasneem Awad', ar: 'تسنيم عوض' },
  { en: 'Hisham Idris', ar: 'هشام إدريس' },
  { en: 'Nada Ali', ar: 'ندى علي' },
  { en: 'Mujtaba Hassan', ar: 'مجتبى حسن' },
  { en: 'Reem Suliman', ar: 'ريم سليمان' },
  { en: 'Osama Taha', ar: 'أسامة طه' },
  { en: 'Salma Eltayeb', ar: 'سلمى الطيب' },
  { en: 'Anwar Bashir', ar: 'أنور بشير' },
  { en: 'Mawada Ismail', ar: 'مودة إسماعيل' },
];

