> NOTE (owner): This brief states UX principles. SPEC.md overrides it. It still mentions Expenses, Hasad orders, prepaid-order fulfillment and the weight-difference flow: all removed from scope (REM-1, REM-2). Figma defines the visual language; this brief defines hierarchy, density and role focus.

أريد منك إعادة تصميم وتحسين تجربة المستخدم (UX) وخصوصًا لوحات التحكم (Dashboards) في نظام ERP للمجوهرات متعدد الفروع.

IMPORTANT:
لا أريد مجرد تحسين بصري أو إضافة المزيد من UI components.

المشكلة الأساسية التي أريد حلها هي:
INFORMATION DENSITY / كثافة المعلومات.

النسخة الحالية تحتوي على معلومات صحيحة ومفيدة، لكنها تعرض عددًا كبيرًا من المؤشرات والجداول والرسوم في نفس المستوى البصري، مما يجعل المستخدم يشعر بالـoverwhelm ويصعّب عليه معرفة أين يجب أن يركز.

أريد منك التعامل مع هذه المهمة كـSenior Product Designer + UX Architect متخصص في Enterprise Software / ERP.

━━━━━━━━━━━━━━━━━━━━
1. DESIGN OBJECTIVE
━━━━━━━━━━━━━━━━━━━━

الهدف ليس إظهار أكبر قدر ممكن من البيانات.

الهدف هو:

"Show the right information to the right user at the right time."

أي:

المعلومة الصحيحة
للمستخدم الصحيح
في الوقت الصحيح
وبالدرجة المناسبة من التفاصيل.

يجب أن تكون لوحة التحكم Decision-Oriented وليست Data-Dump.

لا تجعل الـDashboard متحفًا للبيانات.

يجب أن تساعد المستخدم على الإجابة بسرعة عن:

1. ماذا يحدث الآن؟
2. هل هناك شيء يحتاج انتباهي؟
3. هل هناك مشكلة؟
4. لماذا تحدث؟
5. ماذا يجب أن أفعل؟

━━━━━━━━━━━━━━━━━━━━
2. INFORMATION HIERARCHY
━━━━━━━━━━━━━━━━━━━━

أعد بناء Information Hierarchy لكل Dashboard.

استخدم ثلاثة مستويات:

LEVEL 1 — AT A GLANCE

معلومات يستطيع المستخدم فهمها خلال 5–10 ثوانٍ.

مثال:

- إجمالي المبيعات
- إجمالي الربح
- المصروفات
- قيمة/وزن المخزون
- عدد العمليات
- تنبيهات مهمة

لا تعرض أكثر من العدد الضروري من الـprimary KPIs.

LEVEL 2 — EXPLANATION

معلومات تساعد المستخدم على فهم:

"لماذا حدث ذلك؟"

مثل:

- Sales trends
- Profit trends
- Branch comparison
- Inventory movement
- Gold weight movement
- Significant changes

LEVEL 3 — DETAILS

المعلومات التشغيلية التفصيلية:

- invoices
- transactions
- inventory movements
- expenses
- users
- audit records
- individual items

هذه لا يجب أن تنافس Level 1 بصريًا.

━━━━━━━━━━━━━━━━━━━━
3. PROGRESSIVE DISCLOSURE
━━━━━━━━━━━━━━━━━━━━

استخدم مبدأ:

Progressive Disclosure.

لا تعرض كل التفاصيل افتراضيًا.

المستخدم يرى Summary أولًا.

ثم يستطيع الانتقال إلى:

Summary
→ Explanation
→ Details

مثال:

بدل عرض جدول ضخم لحركة المخزون في Dashboard:

اعرض:

"حركة المخزون اليوم"

51 قطعة
652.390 جم

ثم:

[عرض التفاصيل]

وعند الضغط يمكن الانتقال إلى صفحة المخزون التفصيلية.

━━━━━━━━━━━━━━━━━━━━
4. ONE SCREEN → ONE PRIMARY DECISION
━━━━━━━━━━━━━━━━━━━━

كل شاشة يجب أن يكون لها Primary User Goal.

لا تجعل الصفحة تحاول القيام بكل شيء.

أمثلة:

Dashboard:
"هل هناك شيء يحتاج تدخلي الآن؟"

Sales:
"ماذا بعنا؟"

Inventory:
"ماذا لدينا وأين؟"

Purchases:
"ماذا دخل إلى النظام؟"

Expenses:
"أين ذهب المال؟"

Hasad:
"ما الطلبات التي تحتاج إجراء؟"

Reports:
"ماذا حدث ولماذا؟"

Audit:
"من فعل ماذا ومتى؟"

إذا كانت هناك معلومات لا تخدم الهدف الأساسي للصفحة، انقلها إلى مستوى أعمق.

━━━━━━━━━━━━━━━━━━━━
5. GENERAL MANAGER DASHBOARD
━━━━━━━━━━━━━━━━━━━━

المدير العام لا يحتاج إلى Dashboard مزدحمة.

هو يحتاج إلى Command Center.

صمم الـGeneral Manager Dashboard حول:

A. BUSINESS HEALTH

- Sales
- Gross Profit
- Expenses
- Inventory Value / Weight
- Number of Branches
- Critical Alerts

B. ATTENTION REQUIRED

هذا القسم مهم جدًا.

ضع فيه الأشياء التي تتطلب تدخل المدير فقط.

أمثلة:

- unusual expense
- inventory discrepancy
- pending prepaid order
- unusual sales decline
- suspicious activity
- branch requiring attention
- important approval

إذا لم يوجد شيء يحتاج التدخل:

اعرض حالة إيجابية بسيطة:

"لا توجد إجراءات عاجلة."

لا تعرض بيانات لمجرد ملء الفراغ.

C. BUSINESS PERFORMANCE

اعرض trends وcomparisons:

- Sales trend
- Profit trend
- Branch comparison
- Gold weight movement

D. DRILL-DOWN

اجعل المستخدم يستطيع الانتقال من:

Company
→ Branch
→ Transaction
→ Item

بدون إغراق الصفحة الرئيسية بالتفاصيل.

━━━━━━━━━━━━━━━━━━━━
6. GENERAL MANAGER ≠ BRANCH MANAGER
━━━━━━━━━━━━━━━━━━━━

لا تستخدم نفس Dashboard لجميع المستخدمين.

Role-based UX يجب أن يكون واضحًا.

GENERAL MANAGER:

يهتم بـ:

- Company-wide performance
- Branch comparison
- Profitability
- Inventory across branches
- Exceptions
- Users
- Audit
- Strategic decisions

BRANCH MANAGER:

يهتم بـ:

- Today's sales
- Branch inventory
- Expenses
- Cash/payment activity
- Hasad orders
- Staff activity
- Operational exceptions

CASHIER:

يهتم بـ:

- POS
- Current transactions
- Customers
- Payment
- Hasad fulfillment
- My activity

لا تجعل المستخدم يرى information لا يحتاجها في عمله اليومي.

━━━━━━━━━━━━━━━━━━━━
7. REDUCE COGNITIVE LOAD
━━━━━━━━━━━━━━━━━━━━

طبّق مبادئ Cognitive Load Reduction.

تجنب:

- excessive cards
- excessive borders
- excessive colors
- excessive icons
- redundant information
- repeated labels
- unnecessary charts
- multiple competing primary actions

لا تجعل كل عنصر في الصفحة يحاول أن يكون مهمًا.

إذا كان كل شيء مهمًا بصريًا،
فلا شيء مهم بصريًا.

━━━━━━━━━━━━━━━━━━━━
8. VISUAL HIERARCHY
━━━━━━━━━━━━━━━━━━━━

استخدم hierarchy واضحة:

Primary
Secondary
Tertiary

يجب أن يعرف المستخدم بصريًا:

ما هو الأهم؟
ما هو ثانوي؟
ما هو مجرد سياق؟

استخدم:

- typography hierarchy
- whitespace
- grouping
- alignment
- spacing
- subtle borders
- restrained colors

بدل الاعتماد على كثرة الـcards والـcolors.

━━━━━━━━━━━━━━━━━━━━
9. DASHBOARD CARD DISCIPLINE
━━━━━━━━━━━━━━━━━━━━

لا تستخدم Cards لكل شيء.

الـCard يجب أن تستخدم عندما تكون هناك علاقة منطقية بين المعلومات.

لا تحول كل metric إلى Card منفصلة.

تجنب النمط:

[Card]
[Card]
[Card]
[Card]
[Card]
[Card]
[Card]

لأنه يخلق visual noise.

استخدم sections وtables وinline metrics عند الحاجة.

━━━━━━━━━━━━━━━━━━━━
10. DATA DENSITY BY CONTEXT
━━━━━━━━━━━━━━━━━━━━

مهم جدًا:

لا تقلل Information Density في كل أجزاء النظام.

الـDashboard يجب أن تكون منخفضة إلى متوسطة الكثافة.

لكن:

Sales table
Inventory table
Audit log
Reports

يمكن أن تكون عالية الكثافة لأن المستخدم يدخلها خصيصًا لتحليل البيانات.

إذن:

Dashboard = Low/Medium Density
Operational Pages = Medium/High Density
Detailed Reports = High Density

لا تطبق "minimalism" بشكل أعمى.

━━━━━━━━━━━━━━━━━━━━
11. ATTENTION MANAGEMENT
━━━━━━━━━━━━━━━━━━━━

صمم النظام بحيث يوجه انتباه المستخدم.

استخدم الألوان فقط عندما تحمل معنى.

مثال:

Normal
Warning
Critical
Success

لا تستخدم اللون لمجرد decoration.

لا تستخدم أكثر من لون accent أساسي بدون سبب.

اللون الذهبي يجب أن يكون جزءًا من Brand Identity وليس لونًا لكل شيء.

━━━━━━━━━━━━━━━━━━━━
12. EMPTY STATES
━━━━━━━━━━━━━━━━━━━━

لا تترك مساحات فارغة تبدو كأن النظام ناقص.

إذا لم توجد بيانات:

استخدم meaningful empty states.

مثال:

"لا توجد طلبات حصاد تحتاج إجراء."

بدل:

"No data."

━━━━━━━━━━━━━━━━━━━━
13. LOADING & ERROR STATES
━━━━━━━━━━━━━━━━━━━━

صمم أيضًا:

- loading states
- skeleton states
- empty states
- error states
- success states
- permission denied states

لا تجعل تجربة المستخدم مصممة فقط للحالة المثالية.

━━━━━━━━━━━━━━━━━━━━
14. TABLE UX
━━━━━━━━━━━━━━━━━━━━

الجداول في ERP مهمة جدًا.

لا تحاول جعلها جميلة فقط.

اجعلها efficient.

راعِ:

- readable columns
- sorting
- filtering
- search
- pagination
- column priority
- column visibility
- sticky headers عندما تكون مناسبة
- row actions
- detail drawer/page

لا تعرض 15 عمودًا افتراضيًا إذا كان المستخدم يحتاج 6 فقط.

يمكن استخدام:

Primary columns
+
"عرض التفاصيل"

للمعلومات الثانوية.

━━━━━━━━━━━━━━━━━━━━
15. NAVIGATION
━━━━━━━━━━━━━━━━━━━━

راجع Sidebar.

يجب أن يكون:

- predictable
- grouped
- role-aware
- consistent

لا تجعل المستخدم يحتاج إلى تذكر أين توجد الوظيفة.

قسّم navigation إلى logical domains.

مثال:

التشغيل
- نقطة البيع
- المبيعات
- المخزون
- المشتريات
- المصروفات
- التحويلات

التحليلات
- التقارير
- الأداء
- المقارنات

إدارة النظام
- المستخدمون
- المستخدمون النشطون
- سجل التدقيق

لكن استخدم التسميات التي تناسب domain الحقيقي للنظام.

━━━━━━━━━━━━━━━━━━━━
16. USER FLOW
━━━━━━━━━━━━━━━━━━━━

راجع أهم workflows:

Login
→ Dashboard
→ Sale
→ Inventory update
→ Invoice
→ Payment
→ Audit

و:

Hasad Order
→ Branch
→ Jewelry Selection
→ Weight Difference
→ Payment / Difference
→ Fulfillment

حدد:

- unnecessary clicks
- confusing transitions
- duplicated actions
- unnecessary forms
- missing confirmation
- dangerous actions

الهدف هو تقليل friction دون التضحية بالأمان.

━━━━━━━━━━━━━━━━━━━━
17. DANGEROUS ACTIONS
━━━━━━━━━━━━━━━━━━━━

عمليات مثل:

- deleting
- reversing
- inventory adjustment
- changing prices
- financial corrections
- fulfilling prepaid orders

يجب أن تكون واضحة ومقصودة.

استخدم confirmation وreason/audit عندما يكون ذلك مطلوبًا.

لكن لا تجعل كل click يحتاج confirmation.

━━━━━━━━━━━━━━━━━━━━
18. RESPONSIVE / SCREEN SIZE
━━━━━━━━━━━━━━━━━━━━

صمم النظام أساسًا لشاشات desktop/laptop لأن ERP سيستخدم في بيئة عمل.

لكن اجعل التصميم responsive عند الحاجة.

لا تحاول ضغط Dashboard desktop كاملة داخل شاشة الهاتف.

━━━━━━━━━━━━━━━━━━━━
19. VISUAL IDENTITY
━━━━━━━━━━━━━━━━━━━━

احتفظ بالهوية الحالية:

- dark navy
- restrained gold accent
- white/light neutral surfaces
- Arabic RTL
- professional typography

لكن لا تبالغ في استخدام الذهب.

أريد الإحساس:

Premium Jewelry Business + Enterprise Software

وليس:

Luxury Landing Page.

━━━━━━━━━━━━━━━━━━━━
20. AVOID "AI-GENERATED UI" PATTERNS
━━━━━━━━━━━━━━━━━━━━

لا أريد:

- generic SaaS dashboard
- excessive gradients
- excessive glassmorphism
- random decorative icons
- excessive rounded cards
- giant meaningless numbers
- unnecessary charts
- fake complexity
- excessive animations
- decorative elements with no functional purpose

كل عنصر يجب أن يخدم:

Information
Navigation
Decision
Action

إذا لم يخدم واحدًا منها، اسأل إن كان يجب أن يكون موجودًا.

━━━━━━━━━━━━━━━━━━━━
21. DESIGN SYSTEM
━━━━━━━━━━━━━━━━━━━━

قبل إعادة بناء الصفحات، أنشئ Design System واضحًا:

- Typography scale
- Spacing scale
- Color tokens
- Border radius
- Shadows
- Button hierarchy
- Input styles
- Table styles
- Badge styles
- Alert styles
- Modal styles
- Navigation states
- Empty states
- Loading states

ثم استخدم Design System consistently.

لا تجعل كل صفحة لها أسلوب مختلف.

━━━━━━━━━━━━━━━━━━━━
22. DO NOT DESTROY EXISTING FUNCTIONALITY
━━━━━━━━━━━━━━━━━━━━

هذه مهمة UX/UI Refactoring.

لا تقم بإزالة functionality موجودة فقط لأنها لا تظهر في الـDashboard.

انقلها إلى المكان الصحيح إذا كانت كثيفة.

احتفظ بالـbusiness logic والـpermissions والـdata model ما لم تجد مشكلة حقيقية.

افصل:

UX improvements
عن
business logic changes.

━━━━━━━━━━━━━━━━━━━━
23. IMPORTANT — ANALYZE BEFORE CODING
━━━━━━━━━━━━━━━━━━━━

قبل تعديل الكود:

1. حلل الـcurrent UI.
2. حدد مصادر Information Density.
3. حدد العناصر التي تتنافس على الانتباه.
4. حدد redundant information.
5. حدد المعلومات التي يجب نقلها إلى drill-down.
6. حدد Primary User Goals لكل صفحة.
7. حدد الاختلاف بين General Manager وBranch Manager وCashier.
8. اقترح Information Architecture جديدة.
9. اقترح Dashboard hierarchy جديدة.
10. ثم نفذ التعديلات.

لا تبدأ بالكود مباشرة.

━━━━━━━━━━━━━━━━━━━━
24. REVIEW YOUR OWN DESIGN
━━━━━━━━━━━━━━━━━━━━

بعد تنفيذ التعديلات، قم بعمل UX review لنفسك.

اسأل:

- هل يمكن للمستخدم فهم الصفحة خلال 5 ثوانٍ؟
- هل يعرف ما الذي يحتاج انتباهه؟
- هل هناك أكثر من Primary action؟
- هل هناك معلومات كثيرة متنافسة؟
- هل يمكن إزالة أي عنصر؟
- هل الـDashboard أصبحت أكثر هدوءًا؟
- هل أصبح الوصول إلى التفاصيل أسهل؟
- هل التصميم ما زال مناسبًا لـEnterprise ERP؟
- هل يبدو النظام متخصصًا في تجارة المجوهرات؟
- هل هناك أي component يبدو موجودًا فقط لأن AI يحب استخدامه؟

إذا وجدت مشكلة، أصلحها قبل إنهاء المهمة.

━━━━━━━━━━━━━━━━━━━━
FINAL PRINCIPLE

لا أريد "Dashboard جميلة".

أريد:

A calm, information-efficient, decision-oriented Enterprise ERP interface.

The user should feel:

"I understand what is happening."

"I know what needs my attention."

"I know where to go next."

وليس:

"There is a lot of information here, but I don't know where to look."

ابدأ بالتحليل والـUX architecture أولًا، ثم نفذ التعديلات تدريجيًا.
لا تعيد بناء النظام بالكامل دفعة واحدة.
