// Static reference data for the demo (products, people, places). All names are fictional.

export const BRANCHES = [
  { code: 'KRT', name: 'Khartoum Branch', nameAr: 'فرع الخرطوم', city: 'Khartoum', address: 'Al-Qasr Street, Gold Market, Khartoum', phone: '+249 183 000 101', hasadBranchCode: 'HG-BR-KRT' },
  { code: 'OMD', name: 'Omdurman Branch', nameAr: 'فرع أم درمان', city: 'Omdurman', address: 'Souq Omdurman, Gold Lane 4', phone: '+249 187 000 202', hasadBranchCode: 'HG-BR-OMD' },
  { code: 'BHR', name: 'Bahri Branch', nameAr: 'فرع بحري', city: 'Khartoum North', address: 'Al-Mu’assasa, Main Road', phone: '+249 185 000 303', hasadBranchCode: 'HG-BR-BHR' },
  { code: 'PZU', name: 'Port Sudan Branch', nameAr: 'فرع بورتسودان', city: 'Port Sudan', address: 'Souq Al-Kabir, Block 2', phone: '+249 311 000 404', hasadBranchCode: 'HG-BR-PZU' },
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

export const PRODUCTS: { sku: string; name: string; nameAr: string; category: string; karat: number }[] = [
  { sku: 'RG-21-001', name: 'Gold Ring', nameAr: 'خاتم ذهب', category: 'RING', karat: 21 },
  { sku: 'RG-21-002', name: 'Twisted Band Ring', nameAr: 'خاتم مبروم', category: 'RING', karat: 21 },
  { sku: 'RG-18-003', name: 'Solitaire Ring', nameAr: 'خاتم سوليتير', category: 'RING', karat: 18 },
  { sku: 'RG-21-004', name: 'Engraved Wedding Band', nameAr: 'دبلة زواج منقوشة', category: 'RING', karat: 21 },
  { sku: 'RG-18-005', name: 'Cluster Stone Ring', nameAr: 'خاتم فصوص', category: 'RING', karat: 18 },
  { sku: 'RG-22-006', name: 'Signet Ring', nameAr: 'خاتم رجالي', category: 'RING', karat: 22 },
  { sku: 'BR-21-001', name: 'Classic Bangle', nameAr: 'غويشة كلاسيك', category: 'BRACELET', karat: 21 },
  { sku: 'BR-21-002', name: 'Sudanese Hollow Bangle', nameAr: 'غويشة سودانية مفرغة', category: 'BRACELET', karat: 21 },
  { sku: 'BR-22-003', name: 'Cuban Link Bracelet', nameAr: 'أسورة كوبية', category: 'BRACELET', karat: 22 },
  { sku: 'BR-18-004', name: 'Tennis Bracelet', nameAr: 'أسورة تنس', category: 'BRACELET', karat: 18 },
  { sku: 'BR-21-005', name: 'Charm Bracelet', nameAr: 'أسورة دلايات', category: 'BRACELET', karat: 21 },
  { sku: 'NK-21-001', name: 'Filigree Necklace', nameAr: 'عقد مشغول', category: 'NECKLACE', karat: 21 },
  { sku: 'NK-18-002', name: 'Pearl Drop Necklace', nameAr: 'عقد لؤلؤ', category: 'NECKLACE', karat: 18 },
  { sku: 'NK-21-003', name: 'Coin Necklace (Jinaih)', nameAr: 'عقد جنيهات', category: 'NECKLACE', karat: 21 },
  { sku: 'NK-22-004', name: 'Layered Necklace', nameAr: 'عقد طبقات', category: 'NECKLACE', karat: 22 },
  { sku: 'ER-21-001', name: 'Hoop Earrings', nameAr: 'حلق دائري', category: 'EARRING', karat: 21 },
  { sku: 'ER-18-002', name: 'Stud Earrings', nameAr: 'حلق صغير', category: 'EARRING', karat: 18 },
  { sku: 'ER-21-003', name: 'Chandelier Earrings', nameAr: 'حلق ثريا', category: 'EARRING', karat: 21 },
  { sku: 'ER-18-004', name: 'Crescent Earrings', nameAr: 'حلق هلال', category: 'EARRING', karat: 18 },
  { sku: 'CH-21-001', name: 'Rope Chain', nameAr: 'سلسلة حبل', category: 'CHAIN', karat: 21 },
  { sku: 'CH-22-002', name: 'Box Chain', nameAr: 'سلسلة بوكس', category: 'CHAIN', karat: 22 },
  { sku: 'CH-21-003', name: 'Figaro Chain', nameAr: 'سلسلة فيجارو', category: 'CHAIN', karat: 21 },
  { sku: 'CH-24-004', name: 'Pure Gold Chain', nameAr: 'سلسلة ذهب خالص', category: 'CHAIN', karat: 24 },
  { sku: 'PD-21-001', name: 'Heart Pendant', nameAr: 'تعليقة قلب', category: 'PENDANT', karat: 21 },
  { sku: 'PD-21-002', name: 'Ayat Al-Kursi Pendant', nameAr: 'تعليقة آية الكرسي', category: 'PENDANT', karat: 21 },
  { sku: 'PD-24-003', name: 'Gold Pound Pendant', nameAr: 'تعليقة جنيه ذهب', category: 'PENDANT', karat: 24 },
  { sku: 'PD-18-004', name: 'Initial Letter Pendant', nameAr: 'تعليقة حرف', category: 'PENDANT', karat: 18 },
  { sku: 'ST-21-001', name: 'Bridal Set', nameAr: 'طقم عروس', category: 'SET', karat: 21 },
  { sku: 'ST-18-002', name: 'Evening Set', nameAr: 'طقم سهرة', category: 'SET', karat: 18 },
];

export const SUPPLIERS = [
  { name: 'Al-Sharif Gold Workshop', nameAr: 'ورشة الشريف للذهب', phone: '+249 912 300 100' },
  { name: 'Nile Goldsmiths Co.', nameAr: 'شركة النيل للصاغة', phone: '+249 912 300 200' },
  { name: 'Dubai Souk Gold Trading LLC', nameAr: 'دبي سوق الذهب للتجارة', phone: '+971 4 000 0300' },
  { name: 'Istanbul Kuyumculuk A.Ş.', nameAr: 'إسطنبول للمجوهرات', phone: '+90 212 000 0400' },
];

export const CUSTOMER_NAMES = [
  'Mohamed Ahmed', 'Fatima Osman', 'Khalid Abdalla', 'Maha Elfadil', 'Yasir Hamza', 'Rania Mahgoub', 'Ibrahim Nour',
  'Samia Babiker', 'Abubakr Siddig', 'Huda Elamin', 'Walid Karrar', 'Tasneem Awad', 'Hisham Idris', 'Nada Ali',
  'Mujtaba Hassan', 'Reem Suliman', 'Osama Taha', 'Salma Eltayeb', 'Anwar Bashir', 'Mawada Ismail',
];

/** Hasad Gold customers (fictional). */
export const HASAD_CUSTOMERS = [
  { id: 'HC-204518', fullName: 'Ahmed Mohamed', fullNameAr: 'أحمد محمد', phone: '+249 911 204 518', nid: '***-***-4471' },
  { id: 'HC-204533', fullName: 'Fatima Hassan', fullNameAr: 'فاطمة حسن', phone: '+249 911 204 533', nid: '***-***-1908' },
  { id: 'HC-204571', fullName: 'Omer Babiker', fullNameAr: 'عمر بابكر', phone: '+249 911 204 571', nid: '***-***-6624' },
  { id: 'HC-204602', fullName: 'Asia Abdelgadir', fullNameAr: 'آسيا عبدالقادر', phone: '+249 911 204 602', nid: '***-***-3310' },
  { id: 'HC-204615', fullName: 'Mohanad Elnour', fullNameAr: 'مهند النور', phone: '+249 911 204 615', nid: '***-***-7782' },
  { id: 'HC-204640', fullName: 'Selma Kamal', fullNameAr: 'سلمى كمال', phone: '+249 911 204 640', nid: '***-***-0415' },
  { id: 'HC-204688', fullName: 'Hamid Adam', fullNameAr: 'حامد آدم', phone: '+249 911 204 688', nid: '***-***-2297' },
  { id: 'HC-204701', fullName: 'Eman Sharif', fullNameAr: 'إيمان شريف', phone: '+249 911 204 701', nid: '***-***-5561' },
  { id: 'HC-204739', fullName: 'Bakri Mustafa', fullNameAr: 'بكري مصطفى', phone: '+249 911 204 739', nid: '***-***-8843' },
  { id: 'HC-204755', fullName: 'Duaa Alhadi', fullNameAr: 'دعاء الهادي', phone: '+249 911 204 755', nid: '***-***-1126' },
  { id: 'HC-204790', fullName: 'Nasr Eldin Adil', fullNameAr: 'نصر الدين عادل', phone: '+249 911 204 790', nid: '***-***-3390' },
  { id: 'HC-204812', fullName: 'Lina Faisal', fullNameAr: 'لينا فيصل', phone: '+249 911 204 812', nid: '***-***-4458' },
  { id: 'HC-204836', fullName: 'Gamal Hussein', fullNameAr: 'جمال حسين', phone: '+249 911 204 836', nid: '***-***-9087' },
  { id: 'HC-204851', fullName: 'Rawan Elsheikh', fullNameAr: 'روان الشيخ', phone: '+249 911 204 851', nid: '***-***-6612' },
  { id: 'HC-204877', fullName: 'Sami Awadalla', fullNameAr: 'سامي عوض الله', phone: '+249 911 204 877', nid: '***-***-2254' },
  { id: 'HC-204893', fullName: 'Marwa Eltigani', fullNameAr: 'مروة التجاني', phone: '+249 911 204 893', nid: '***-***-7719' },
  { id: 'HC-204910', fullName: 'Yousif Kheir', fullNameAr: 'يوسف خير', phone: '+249 911 204 910', nid: '***-***-3386' },
  { id: 'HC-204934', fullName: 'Afaf Musa', fullNameAr: 'عفاف موسى', phone: '+249 911 204 934', nid: '***-***-5043' },
];
