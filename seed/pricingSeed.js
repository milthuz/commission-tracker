// Seed data for the Services & Pricing Guide (pricing_categories / pricing_packages / pricing_guides).
// Transcribed from the design handoff's pricing-data.js (effective 2026-04-01, CAD).
// English-only at seed time — French content ships as a placeholder copy of English until
// translated via the Admin Pricing editor.

const categories = [
  { id: 'saas',     sort: 0, hourly: null, note: null, considerations: null },
  { id: 'rental',   sort: 1, hourly: null, note: null, considerations: null },
  { id: 'menu',     sort: 2, hourly: 125,  note: null, considerations: null },
  { id: 'install',  sort: 3, hourly: null, note: null, considerations: null },
  { id: 'support',  sort: 4, hourly: null, note: null, considerations: null },
  { id: 'olo',      sort: 5, hourly: null, note: 'CAD — $299 activation fee per service + $29/month per service (training included in activation).',
    considerations: ['Global menus: image uploads to OLO are not supported (menu locked in POS).', 'Global menus: out-of-stock items can’t be deactivated from the POS on OLO.', 'Global-menu merchants may not be the best fit — consider a hybrid menu setup.'] },
  { id: 'shipping', sort: 6, hourly: null, note: 'From Montreal · Standard · add $15 for each additional item.',
    considerations: ['Request custom rate for items exceeding weight limitations.', 'Request custom rate for remote locations.'] },
  { id: 'xperio',   sort: 7, hourly: null, note: null, considerations: null },
];

const packages = [
  // ---------------------------------------------------------------- SaaS
  { id:'sta-qc', cat:'saas', name:'Cluster OS · Starter (Québec)', sku:'CLU-OS-STA-MON-QC', compat:'V1', group:'existing', pos:'1 POS', priceMonthly:99, priceYearly:null, status:'legacy',
    includes:['1 POS license','Core POS features'], internal:{ notes:'Existing-customer legacy rate (QC). Payment integration fees increase $15–20/terminal.' } },
  { id:'bus-qc', cat:'saas', name:'Cluster OS · Business (Québec)', sku:'CLU-OS-BUS-MON-QC', compat:'V1', group:'existing', pos:'2 POS', priceMonthly:169, status:'legacy',
    includes:['2 POS licenses','Core POS features'] },
  { id:'pre-qc', cat:'saas', name:'Cluster OS · Premium (Québec)', sku:'CLU-OS-PRE-MON-QC', compat:'V1', group:'existing', pos:'3+ POS', priceMonthly:229, status:'legacy',
    includes:['3+ POS licenses','Core POS features'] },
  { id:'sta-roc', cat:'saas', name:'Cluster OS · Starter (Rest of Canada)', sku:'CLU-OS-STA-MON', compat:'V1', group:'existing', pos:'1 POS', priceMonthly:79, status:'legacy', includes:['1 POS license'] },
  { id:'bus-roc', cat:'saas', name:'Cluster OS · Business (Rest of Canada)', sku:'CLU-OS-BUS-MON', compat:'V1', group:'existing', pos:'2 POS', priceMonthly:149, status:'legacy', includes:['2 POS licenses'] },
  { id:'pre-roc', cat:'saas', name:'Cluster OS · Premium (Rest of Canada)', sku:'CLU-OS-PRE-MON', compat:'V1', group:'existing', pos:'3+ POS', priceMonthly:199, status:'legacy', includes:['3+ POS licenses'] },

  { id:'go', cat:'saas', name:'Cluster OS · GO', sku:'CLU-OS-GO-MON', skuYear:'CLU-OS-GO-YR', compat:'V1', group:'new', pos:'1 POS', priceMonthly:69, priceYearly:786.60, status:'new',
    includes:['1 POS license','Table Services disabled','With Cluster Payments only'], internal:{ notes:'* Only with Cluster Payments. +$40 / additional license (CLU-OS-GO-ADPOS-MON). Yearly = -5%.' } },
  { id:'essential', cat:'saas', name:'Cluster OS · Essential', sku:'CLU-OS-ES-MON', skuYear:'CLU-OS-ES-YR', compat:'V1', group:'new', pos:'1 POS', priceMonthly:109, priceYearly:1242.60,
    includes:['1 POS license','Full features'] },
  { id:'advanced', cat:'saas', name:'Cluster OS · Advanced', sku:'CLU-OS-ADV-MON', skuYear:'CLU-OS-ADV-YR', compat:'V1', group:'new', pos:'2 POS', priceMonthly:179, priceYearly:2040.60,
    includes:['2 POS licenses','Full features'] },
  { id:'ultimate', cat:'saas', name:'Cluster OS · Ultimate', sku:'CLU-OS-ULT-MON', skuYear:'CLU-OS-ULT-YR', compat:'V1', group:'new', pos:'3+ POS', priceMonthly:269, priceYearly:3066.60,
    includes:['3+ POS licenses','Full features','Includes 2 integrations'] },

  { id:'v2go', cat:'saas', name:'Kaizen · v2GO', sku:'KZN-CLU-OS-GO-MON', skuYear:'KZN-CLU-OS-GO-YRL', compat:'V2', group:'kaizen', pos:'1 POS', priceMonthly:79, priceYearly:900.60, status:'new',
    includes:['1 POS license','QSR features only','With Cluster Payments only'], internal:{ notes:'* Only with Cluster Payments. +$40 / additional POS. Yearly = -5%.' } },
  { id:'v2core', cat:'saas', name:'Kaizen · v2Core', sku:'KZN-CLU-OS-CORE-MON', skuYear:'KZN-CLU-OS-CORE-YRL', compat:'V2', group:'kaizen', pos:'1 POS', priceMonthly:99, priceYearly:1128.60,
    includes:['1 POS license','QSR features only'], internal:{ notes:'tbc / additional POS.' } },
  { id:'v2essential', cat:'saas', name:'Kaizen · v2 Essential', sku:'KZN-CLU-OS-ESS-MON', skuYear:'KZN-CLU-OS-ESS-YRL', compat:'V2', group:'kaizen', pos:'1 POS', priceMonthly:119, priceYearly:1356.60,
    includes:['1 POS license','Full features'] },
  { id:'v2advanced', cat:'saas', name:'Kaizen · v2 Advanced', sku:'KZN-CLU-OS-ADV-MON', skuYear:'KZN-CLU-OS-ADV-YRL', compat:'V2', group:'kaizen', pos:'2 POS', priceMonthly:189, priceYearly:2154.60,
    includes:['2 POS licenses','Full features'] },
  { id:'v2ultimate', cat:'saas', name:'Kaizen · v2 Ultimate', sku:'KZN-CLU-OS-ULT-MON', skuYear:'KZN-CLU-OS-ULT-YRL', compat:'V2', group:'kaizen', pos:'3+ POS', priceMonthly:279, priceYearly:3180.60,
    includes:['3+ POS licenses','Full features','Includes 2 integrations'] },

  // ------------------------------------------------------------- Rental
  { id:'rental-1', cat:'rental', name:'Cluster Rental · 1 POS', sku:'CLU-STA-REN', compat:'V1', pos:'1 POS', priceMonthly:259, unit:'month', term:'2-year',
    includes:['1× Lite POS','1× Lite Cash Drawer','1× Star Receipt Printer (white)','1× Router (non-Ubiquiti)','1× Switch (non-Ubiquiti)','1× Menu Build Package + POS Training + in-person install (30 km of Montreal)','1× Payment Integration + 1 Add-on'],
    internal:{ requirements:'First 2 months required as security deposit. No payment terms. Add each hardware to estimate at 100% discount. Pick EN/FR rental template.' } },
  { id:'rental-2', cat:'rental', name:'Cluster Rental · 2 POS', sku:'CLU-BUS-REN', compat:'V1', pos:'2 POS', priceMonthly:459, unit:'month', term:'2-year',
    includes:['2× Lite POS','2× Lite Cash Drawer','2× Star Receipt Printer (white)','1× Router','1× Switch','Menu Build + Training + install','Payment Integration + 1 Add-on'],
    internal:{ requirements:'Same requirements as 1 POS rental.' } },
  { id:'rental-add-lite', cat:'rental', name:'Add-on · Lite POS (monthly)', sku:null, compat:'V1', priceMonthly:69, unit:'month', includes:['Includes license'], addon:true },
  { id:'rental-add-drawer', cat:'rental', name:'Add-on · Lite Cash Drawer (monthly)', sku:null, compat:'V1', priceMonthly:3, unit:'month', addon:true },
  { id:'rental-add-router', cat:'rental', name:'Add-on · Router (monthly)', sku:null, compat:'V1', priceMonthly:5, unit:'month', addon:true },
  { id:'rental-add-printer', cat:'rental', name:'Add-on · Star USB White Printer (monthly)', sku:null, compat:'V1', priceMonthly:12, unit:'month', addon:true },
  { id:'rental-add-kitchen', cat:'rental', name:'Add-on · Kitchen Printer (monthly)', sku:null, compat:'V1', priceMonthly:18, unit:'month', addon:true },
  { id:'rental-add-cds', cat:'rental', name:'Add-on · Lite Customer Display (monthly)', sku:null, compat:'V1', priceMonthly:10, unit:'month', addon:true },

  // --------------------------------------------------------------- Menu
  { id:'menu-diy', cat:'menu', name:'Menu Build · Do-It-Yourself', sku:'CLU-MENU-PKG-DIY', priceFlat:0, tier:'DIY',
    includes:['Client builds their own menu','1 menu consultation (45 min)','Still requires an Install Package'], internal:{ effort:'0 build hrs · 1 meeting', requirements:'Client needs time between install and go-live. Good fit for new businesses only.' } },
  { id:'menu-small', cat:'menu', name:'Menu Build · Small (Starter / QSR)', sku:'CLU-MENU-PKG-STA-QSR', priceFlat:250, tier:'Small', scope:'Quick Service',
    includes:['10–15 categories','~50 items','~100 modifiers','1 consultation (30 min)','1 review (30 min)','Floor plan: +$125','2nd consultation: +$125'], internal:{ effort:'1 build hr · 1 meeting', requirements:'3-day min lead time. Final menu in digital format.' } },
  { id:'menu-medium', cat:'menu', name:'Menu Build · Medium (Business / Small Sit-Down)', sku:'CLU-MENU-PKG-BUS-SSD', priceFlat:625, tier:'Medium', scope:'Small Sit Down',
    includes:['15–20 categories','50–150 items','100–200 modifiers','1 consultation (1 hr)','1 review (1 hr)','Floor plan: +$125','2nd consultation: +$125'], internal:{ effort:'3 build hrs · 2 meetings', requirements:'5-day min lead time.' } },
  { id:'menu-large', cat:'menu', name:'Menu Build · Large (Enterprise)', sku:'CLU-MENU-PKG-ENT-LG', priceFlat:1125, tier:'Large', scope:'Pizza / Breakfast',
    includes:['20–30 categories','150–300 items','200–300 modifiers','1 consultation (1 hr)','1 review (2 hr)','Floor plan: +$125','2nd consultation: +$125'], internal:{ effort:'6 build hrs · 3 meetings', requirements:'7-day min lead time.' } },
  { id:'menu-custom', cat:'menu', name:'Menu Build · Custom Quote', sku:'CLU-MENU-PKG-CUS', priceFlat:null, tier:'Custom', scope:'Groceries / Chain / Enterprise',
    includes:['30+ categories','300+ items','300+ modifiers','Floor plan available'], internal:{ effort:'TBD', requirements:'Ask for quote. Guidelines approximate.' } },

  // ------------------------------------------------------- Installation
  { id:'ins-onsite-sta', cat:'install', name:'Installation · Starter (Onsite)', sku:'INS-INP', pos:'1 POS', priceFlat:798, mode:'Onsite',
    includes:['1 license, printer, cash drawer','1 router + 1 switch','2× 60 min remote training'], internal:{ requirements:'Montreal area / Quebec City. +$45 each additional hardware.' } },
  { id:'ins-onsite-bus', cat:'install', name:'Installation · Business (Onsite)', sku:'INS-BUS', pos:'2 POS', priceFlat:1199, mode:'Onsite',
    includes:['2 licenses, printers, cash drawers','1 router + 1 switch','2× 60 min remote training'], internal:{ requirements:'Montreal area / Quebec City. +$45 each additional hardware.' } },
  { id:'ins-onsite-pro', cat:'install', name:'Installation · Pro (Onsite)', sku:'INS-PRO', pos:'3+ POS', priceFlat:1899, mode:'Onsite',
    includes:['3+ licenses, printers, cash drawers','1 router + 1 switch','2× 60 min remote training'], internal:{ requirements:'Montreal area / Quebec City. +$45 each additional hardware.' } },
  { id:'ins-rem-sta', cat:'install', name:'Installation · Starter (Remote)', sku:'CLU INS-STA-REM', pos:'1 POS', priceFlat:285, mode:'Remote',
    includes:['1 license, printer, cash drawer','1 router + 1 switch','2× 60 min remote training'], internal:{ requirements:'Anywhere. +$12.50 each additional hardware. Shipping extra.' } },
  { id:'ins-rem-bus', cat:'install', name:'Installation · Business (Remote)', sku:'CLU INS-BUS-REM', pos:'2 POS', priceFlat:349, mode:'Remote',
    includes:['2 licenses, printers, cash drawers','1 router + 1 switch','2× 60 min remote training'], internal:{ requirements:'Anywhere. +$12.50 each additional hardware.' } },
  { id:'ins-rem-pro', cat:'install', name:'Installation · Pro (Remote)', sku:'CLU INS-PRO-REM', pos:'3+ POS', priceFlat:849, mode:'Remote',
    includes:['3+ licenses, printers, cash drawers','1 router + 1 switch','2× 60 min remote training'], internal:{ requirements:'Anywhere. +$12.50 each additional hardware.' } },
  { id:'ins-coo', cat:'install', name:'Installation · Change of Ownership (Remote)', sku:'CLU INS-COO-REM', priceFlat:185, mode:'Remote',
    includes:['Existing hardware','Remote setup'], internal:{ requirements:'Adding hardware → use Remote Install SKUs.' } },
  { id:'ins-coo-trng', cat:'install', name:'Installation · Change of Ownership + Training', sku:'CLU INS-COO-REM-TRNG', priceFlat:285, mode:'Remote',
    includes:['Existing hardware','Remote setup + training'] },

  // ------------------------------------------------------------ Support
  { id:'sup-gold', cat:'support', name:'GOLD · Standard Support', sku:null, priceFlat:0, unit:'month', tier:'Gold', hours:'6 AM – 10 PM EST',
    includes:['Phone support','Email support','Support via POS','Support via Cluster Cloud','Support via WhatsApp'], internal:{ notes:'Included in SaaS. Managed by Frontline Support Team.' } },
  { id:'sup-goldplus', cat:'support', name:'GOLD+ · VIP / Priority Support', sku:null, priceMonthly:29, unit:'month', tier:'Gold+', hours:'8 AM – 6 PM EST',
    includes:['Includes GOLD features','‘Jump the Queue’ of Level 1 support (before 8 AM & after 6 PM)'], internal:{ notes:'For qualified customers. Escalation Support Team.' } },
  { id:'sup-titanium', cat:'support', name:'Titanium · After-Hours Support', sku:null, priceMonthly:49, unit:'month', tier:'Titanium', hours:'10 PM – 6 AM EST',
    includes:['Includes GOLD features','Request-callback service'], internal:{ notes:'For qualified customers. After-Hours Support Team.' } },
  { id:'sup-platinum', cat:'support', name:'Platinum · Ultimate Support', sku:null, priceMonthly:79, unit:'month', tier:'Platinum', hours:'24/7',
    includes:['Includes Titanium features','Yearly menu review','Yearly POS maintenance review','Yearly staff refresher training','Extended warranty (2 years)','SplashTop account license'], internal:{ notes:'Blended Support Team.' } },
  { id:'sup-partner', cat:'support', name:'Partner · Concierge', sku:null, priceFlat:0, unit:'month', tier:'Partner', hours:'8 AM – 6 PM EST',
    includes:['Includes GOLD+ features'], internal:{ notes:'Included service for Cluster Partners. Specialized Support Team.' } },

  // ----------------------------------------------------------- Shipping
  { id:'ship-qc', cat:'shipping', name:'Shipping · Québec', sku:null, priceFlat:50, unit:'1 item', meta:'5–7 business days', extra:15 },
  { id:'ship-roc', cat:'shipping', name:'Shipping · Rest of Canada', sku:null, priceFlat:65, unit:'1 item', meta:'5–7 business days', extra:15 },
  { id:'ship-usa', cat:'shipping', name:'Shipping · USA', sku:null, priceFlat:80, unit:'1 item', meta:'5–7 business days', extra:15 },

  // ----------------------------------------------------- On-site (XPERIO)
  { id:'xp-onsite', cat:'xperio', name:'Cluster On-Site Charge', sku:null, priceFlat:285, unit:'weekday', rates:{ Weekday:285, Evening:399, Weekend:399 },
    includes:['On-site technician'], internal:{ notes:'Additional hours $125/hr (all periods).' } },
  { id:'xp-reseller', cat:'xperio', name:'Reseller / Haluk Charge', sku:null, priceFlat:175, unit:'weekday', rates:{ Weekday:175, Evening:225, Weekend:225 },
    includes:['Reseller on-site (our charge)'], internal:{ notes:'Additional hours $80 weekday / $100 evening & weekend.' } },
  { id:'xp-menu', cat:'xperio', name:'Menu · per hour', sku:null, priceFlat:125, unit:'hour' },
  { id:'xp-training', cat:'xperio', name:'Training · per hour', sku:null, priceFlat:300, unit:'hour' },
  { id:'xp-qc', cat:'xperio', name:'Travel · Québec City', sku:null, priceFlat:300, unit:'trip', internal:{ notes:'Travel + 1 hr TOS.' } },
  { id:'xp-ottawa', cat:'xperio', name:'Travel · Ottawa', sku:null, priceFlat:300, unit:'trip', internal:{ notes:'Travel + 1 hr TOS.' } },
  { id:'xp-toronto', cat:'xperio', name:'Travel · Toronto', sku:null, priceFlat:600, unit:'trip', internal:{ notes:'Travel + 1 hr TOS.' } },
  { id:'xp-gtm', cat:'xperio', name:'Travel · GTM Region', sku:null, priceFlat:null, unit:'trip', internal:{ notes:'50 km radius (100 km round trip) included, then $3 / extra km.' } },

  // ------------------------------------------------- Online Ordering (OLO)
  { id:'olo-online', cat:'olo', name:'Cluster Online Ordering', sku:'CLU-ONL-MON', priceMonthly:29, activation:299, unit:'month', includes:['Online ordering website','Training included in activation'] },
  { id:'olo-tableside', cat:'olo', name:'Cluster Tableside Ordering', sku:'CLU-TAB-MON', priceMonthly:29, activation:299, unit:'month', includes:['Tableside ordering','Training included in activation'] },
  { id:'olo-qr', cat:'olo', name:'Cluster Counter QR Codes', sku:'CLU-QRC-MON', priceMonthly:29, activation:299, unit:'month', includes:['Counter QR ordering','Training included in activation'] },
];

const guides = [
  { id:'supported-hw', title:'Minimum Supported Hardware', body:'Re-used hardware must meet minimums; all new installs on Windows 11. Lite POS (2023) / any IBM-PC compatible: 2 GHz, 8 GB RAM, 128 GB. Printers: Epson TM-T88/T20/M30/U220/L90/L100, Star TSP100/143 (USB-B for dedicated receipts, Ethernet for kitchen/shared).' },
  { id:'tablets-rdp', title:'Imaged Tablets vs. RDP', body:'Imaged Windows tablets run Cluster POS natively (offline support, full peripheral support, can be main/secondary/KDS). RDP tablets add Apple-Store cost and depend on live connectivity. Prefer imaged tablets for reliability.' },
  { id:'delivery-hub', title:'Cluster Delivery Hub', body:'One-stop shop to manage online-ordering menus for third-party DSPs and stream orders to the POS. Set hours/prep time, recalc prices, rename/add images, pause services. Pre-orders not supported; orders appear when prep time begins.' },
];

module.exports = { categories, packages, guides };
