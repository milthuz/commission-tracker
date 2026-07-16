// Seed data for the Hardware Overview catalog (hardware_categories / hardware_products).
// Transcribed from the design handoff's hardware-data.js. English-only at seed time — French
// content ships as a placeholder copy of English until translated via the Admin Hardware editor.
// img: base filename under assets/hardware-seed-img/; imgJpg lists which ones are .jpg (rest .png).

const categories = [
  { id: 'pos',    sort: 0 },
  { id: 'tab',    sort: 1 },
  { id: 'kp',     sort: 2 },
  { id: 'rp',     sort: 3 },
  { id: 'pay',    sort: 4 },
  { id: 'disp',   sort: 5 },
  { id: 'net',    sort: 6 },
  { id: 'periph', sort: 7 },
  { id: 'cash',   sort: 8 },
];

const imgJpg = ['p3', 'p4', 'p5', 'p6', 'p11', 'p27', 'p29', 'p40', 'p43', 'p45', 'p46', 'p52', 'p57'];

const products = [
  { id:'touchdynamics', name:'15" Touch Dynamics POS', cat:'pos', img:'p3', status:['legacy'], compat:['V1'], specs:['All-in-one 15" LCD touch','8GB / 128GB','Ultra MSR'], sku:'LI-P5180NA1N-00NNNNN-CLS2', price:'$1,150', use:'Full-service & QSR counters', warranty:'1-yr manufacturer', note:'Being replaced by the 15" Ascent POS.' },
  { id:'clusterlite', name:'15" Cluster Lite POS', cat:'pos', img:'p4', status:[], compat:['V1'], specs:['15" touchscreen','8GB / 128GB','White chassis'], sku:'CLU-LIT-WHI-w11', price:'$950', use:'QSR & counter service', warranty:'1-yr manufacturer', note:'' },
  { id:'hprp9', name:'HP RP9 15.6" POS', cat:'pos', img:'p5', status:[], compat:['V1'], specs:['15.6" all-in-one','8GB DDR4 / 128GB SSD M.2','Wi-Fi · G1 Retail 9015'], sku:'CLU-HP-RP9', price:'$1,400', use:'High-volume, multi-station sites', warranty:'1-yr manufacturer', note:'Preferred when numerous stations are needed.' },
  { id:'ascent', name:'Ascent 15.1" POS', cat:'pos', img:'p6', status:['new'], compat:['V1'], specs:['Custom America','15.1" touch','8GB / 128GB · Wi-Fi'], sku:'935KY461F00L33', price:'$1,250', use:'Full-service & QSR counters', warranty:'2-yr manufacturer', note:'Replacing the Touch Dynamics POS.' },
  { id:'trekpos', name:'15.6" Trek POS (Android)', cat:'pos', img:'p56', status:['new'], compat:['V2'], specs:['Custom America · Android','8GB RAM','Ethernet + USB'], sku:'935PW010100L33', price:'$1,300', use:'High-volume Kaizen sites', warranty:'2-yr manufacturer', note:'Kaizen-native Android terminal.' },

  { id:'tabdock', name:'10" Tablet & Docking Station', cat:'tab', img:'p8', status:['legacy'], compat:['V1'], specs:['8GB','Includes docking station'], sku:'CLU-HP-TAB-DOC-STA', price:'$700', use:'Line-busting & tableside', warranty:'1-yr manufacturer', note:'Being replaced by the T-Ranger.' },
  { id:'hptab', name:'HP 12" Tablet Pro X2', cat:'tab', img:'p9', status:['legacy'], compat:['V1'], specs:['12" tablet · 8GB','Refurbished stock'], sku:'CLU-HP-TAB-USED', price:'$650', use:'Tableside ordering', warranty:'90-day', note:'Being replaced by the T-Ranger.' },
  { id:'tranger', name:'10.1" T-Ranger Tablet', cat:'tab', img:'p10', status:['soon'], compat:['V1'], specs:['Custom America','10.1" rugged tablet'], sku:'TBD', price:'TBD', use:'Tableside & line-busting', warranty:'2-yr manufacturer', note:'In testing — replacing the HP tablets.' },
  { id:'minipos', name:'Mini POS (Fanless Mini PC)', cat:'tab', img:'p11', status:[], compat:['V1'], specs:['Fanless mini PC','8GB RAM / 256GB SSD','Requires screen & mouse'], sku:'MINI', price:'$480', use:'Ideal for Cluster KDS', warranty:'1-yr manufacturer', note:'RP9 is the better all-in-one option.' },
  { id:'p18', name:'10.9" P18 Smart Tablet', cat:'tab', img:'p55', status:['new'], compat:['V2'], specs:['Android 13','4GB RAM / 64GB ROM','USB-C · wireless + dock'], sku:'CLU-KAIZEN-P18', price:'$540', use:'QSR & food trucks', warranty:'1-yr manufacturer', note:'Kaizen hybrid POS tablet.' },
  { id:'galaxy', name:'11" Galaxy Tab A9+ (Android)', cat:'tab', img:'p57', status:['new'], compat:['V2'], specs:['Samsung · Android','4GB RAM','Stand not included'], sku:'SM-X210NZAAXAC', price:'$320', use:'POS or KDS', warranty:'1-yr manufacturer', note:'Flexible Kaizen tablet.' },

  { id:'u220', name:'Epson TM-U220B / Ethernet', cat:'kp', img:'p13', status:['eol'], compat:['V1'], specs:['Impact kitchen printer','Auto-cutter · DHCP','Ethernet (UB-E04)'], sku:'C31C514767', price:'$285', use:'Kitchen / hot line', warranty:'1-yr manufacturer', note:'End of life — replaced by the U220IIB.' },
  { id:'u220ii', name:'Epson TM-U220IIB / Ethernet', cat:'kp', img:'p14', status:[], compat:['V1','V2'], specs:['Impact kitchen printer','Auto-cutter','Ethernet (UB-E04) · dark gray'], sku:'C31CL27032', price:'$310', use:'Kitchen / hot line', warranty:'1-yr manufacturer', note:'Kaizen-supported over Ethernet.' },

  { id:'l90', name:'Epson L90II Label Printer / Ethernet', cat:'rp', img:'p16', status:[], compat:['V1'], specs:['LFC thermal label','Ethernet · USB','Receipt / sticky paper only'], sku:'C31C412A7231', price:'$390', use:'Label & sticky order tickets', warranty:'1-yr manufacturer', note:'New model coming soon (L100).' },
  { id:'t88vi', name:'Epson TM-T88VI (White)', cat:'rp', img:'p17', status:[], compat:['V1'], specs:['Thermal receipt','USB · Ethernet · Serial','White'], sku:'C31CE94051', price:'$360', use:'Front-counter receipts', warranty:'1-yr manufacturer', note:'Currently testing — plenty in stock.' },
  { id:'t20iv', name:'Epson TM-T20IV', cat:'rp', img:'p18', status:[], compat:['V1'], specs:['Thermal receipt','USB · Ethernet · Serial','Black'], sku:'C31CL47002', price:'$230', use:'Front-counter receipts', warranty:'1-yr manufacturer', note:'Replaced the T20III.' },
  { id:'m30black', name:'Epson TM-M30III (Black)', cat:'rp', img:'p19', status:['new'], compat:['V1','V2'], specs:['3" thermal receipt','USB-A/B · Ethernet · Wi-Fi · BT','Auto-cutter · black'], sku:'C31CK50022', price:'$300', use:'Kaizen-recommended receipts', warranty:'1-yr manufacturer', note:'Recommended printer for Kaizen.' },
  { id:'m30white', name:'Epson TM-M30III (White)', cat:'rp', img:'p20', status:['new'], compat:['V1','V2'], specs:['3" thermal receipt','USB-A/B · Ethernet · Wi-Fi · BT','Auto-cutter · white'], sku:'C31CK50021', price:'$300', use:'Kaizen-recommended receipts', warranty:'1-yr manufacturer', note:'Recommended printer for Kaizen.' },
  { id:'t88vii', name:'Epson TM-T88VII', cat:'rp', img:null, status:['wsl'], compat:['V1','V2'], specs:['Thermal receipt','USB · Serial · Ethernet'], sku:'C31CJ57012', price:'—', use:'Front-counter receipts', warranty:'As-is', note:'Available until stock is depleted — not reordering. Kaizen-supported over Ethernet.' },
  { id:'t20iii_us', name:'Epson TM-T20III (USB / Serial)', cat:'rp', img:null, status:['wsl'], compat:['V1'], specs:['Thermal receipt','USB · Serial'], sku:'C31CH51001', price:'—', use:'Front-counter receipts', warranty:'As-is', note:'Available until stock is depleted — not reordering.' },
  { id:'t88v', name:'Epson TM-T88V (Lightly Used)', cat:'rp', img:null, status:['wsl'], compat:['V1'], specs:['Thermal receipt','USB · Serial · refurbished'], sku:'C31CA85084', price:'—', use:'Front-counter receipts', warranty:'As-is', note:'Available until stock is depleted — not reordering.' },
  { id:'star143', name:'Star TSP143IIIU (White)', cat:'rp', img:null, status:['wsl'], compat:['V1'], specs:['Thermal receipt','USB · white'], sku:'39472410', price:'—', use:'Front-counter receipts', warranty:'As-is', note:'Available until stock is depleted — not reordering.' },
  { id:'starts', name:'Star Thermal / Serial Printer', cat:'rp', img:null, status:['wsl'], compat:['V1'], specs:['Thermal receipt','Serial'], sku:'37964370', price:'—', use:'Front-counter receipts', warranty:'As-is', note:'Available until stock is depleted — not reordering.' },
  { id:'t20iii_eth', name:'Epson TM-T20III (Ethernet)', cat:'rp', img:null, status:['wsl'], compat:['V1','V2'], specs:['Thermal receipt','Ethernet'], sku:'C31CH51A9972', price:'—', use:'Front-counter receipts', warranty:'As-is', note:'Available until stock is depleted — not reordering. Kaizen-supported over Ethernet.' },

  { id:'s1f2', name:'S1F2 Wireless Terminal', cat:'pay', img:'p23', status:['rental'], compat:['V1'], specs:['Wi-Fi · LTE','Comes with base'], sku:'CLU-PAY-S1F2', price:'Monthly rental', use:'Mobile / tableside pay', warranty:'Included with rental', note:'LTE integrated payments are not supported on Kaizen.' },
  { id:'v400c', name:'V400C Wired Terminal', cat:'pay', img:'p24', status:['rental'], compat:['V1'], specs:['Ethernet or Wi-Fi','Countertop'], sku:'CLU-PAY-V400C', price:'Monthly rental', use:'Countertop pay', warranty:'Included with rental', note:'New model coming soon.' },
  { id:'sfo1', name:'SFO1 Terminal', cat:'pay', img:'p25', status:['new','rental'], compat:['V1','V2'], specs:['Countertop','Doubles as Kaizen CFD'], sku:'CLU-PAY-SFO1', price:'Monthly rental', use:'Pay + customer-facing display', warranty:'Included with rental', note:'Replacing the V400. With Kaizen it doubles as a customer-facing display at no extra cost.' },

  { id:'cdstd', name:'Customer Display (Touch Dynamics)', cat:'disp', img:'p27', status:[], compat:['V1'], specs:['Integrated rear PCAP','11.6" LCD','For non-foldable Ultra base'], sku:'RZ-11DISP-ULT-01', price:'$320', use:'Customer-facing display', warranty:'1-yr manufacturer', note:'' },
  { id:'litecds', name:'Lite Customer Display', cat:'disp', img:'p28', status:[], compat:['V1'], specs:['10" free-standing','Non-touch'], sku:'CLU-LIT-CDS', price:'$260', use:'Customer-facing display', warranty:'1-yr manufacturer', note:'' },
  { id:'ascentcds', name:'Ascent 11" Customer Display', cat:'disp', img:'p29', status:['new'], compat:['V1'], specs:['Custom America','11.6" secondary touch','For Ascent POS'], sku:'932AD050100002', price:'$340', use:'Customer-facing display', warranty:'2-yr manufacturer', note:'Pairs with the Ascent POS.' },
  { id:'hpcds', name:'HP 10" Customer-Facing Display (Touch)', cat:'disp', img:'p30', status:['new'], compat:['V1'], specs:['L7010T for RP9','10.1" · 16:9 · 30ms','USB-DisplayPort · black'], sku:'T6N30AA#ABA', price:'$300', use:'Customer-facing display', warranty:'1-yr manufacturer', note:'Pairs with the HP RP9.' },
  { id:'trekcfd', name:'11.6" Trek Customer-Facing Display', cat:'disp', img:'p59', status:['new'], compat:['V2'], specs:['Custom America','For Trek POS','Default CFD'], sku:'932PW010400M33', price:'$310', use:'Kaizen customer display', warranty:'2-yr manufacturer', note:'' },
  { id:'trekcfdt', name:'11.6" Trek CFD — Touch + NFC', cat:'disp', img:'p60', status:['new'], compat:['V2'], specs:['Custom America','Touch-enabled · NFC','For Trek POS'], sku:'932PW010300M33', price:'$360', use:'Kaizen customer display + tap', warranty:'2-yr manufacturer', note:'' },
  { id:'trekarm', name:'11.6" Trek CFD Rear-Mount Arm', cat:'disp', img:'p61', status:['new'], compat:['V2'], specs:['Custom America','Rear-facing mount','For Trek POS'], sku:'938PW010100010', price:'$70', use:'CFD mounting accessory', warranty:'1-yr manufacturer', note:'Accessory for the Trek CFD.' },

  { id:'udr7', name:'Ubiquiti Dream Router 7', cat:'net', img:'p32', status:['new'], compat:['V1','V2'], specs:['10G cloud gateway','Wi-Fi 7 · PoE switch','microSD · UniFi'], sku:'UDR7 (15W)', price:'$280', use:'Primary site router', warranty:'1-yr manufacturer', note:'Replacing other router options.' },
  { id:'ux7', name:'Ubiquiti UniFi Express 7', cat:'net', img:'p33', status:['new'], compat:['V1','V2'], specs:['Compact 10G gateway','Wi-Fi 7 · mesh-scalable'], sku:'UX7', price:'$150', use:'Small-site router', warranty:'1-yr manufacturer', note:'Replacing other router options.' },
  { id:'usw16', name:'Ubiquiti Switch Lite 16 PoE', cat:'net', img:'p34', status:['new'], compat:['V1','V2'], specs:['16-port Layer 2 PoE','Wall-mountable · fanless'], sku:'USW-Lite-16-POE (45W)', price:'$200', use:'Multi-device sites', warranty:'1-yr manufacturer', note:'Replacing other switch options.' },
  { id:'usw8', name:'Ubiquiti Switch Lite 8 PoE', cat:'net', img:'p35', status:['new'], compat:['V1','V2'], specs:['8-port Layer 2 PoE','Silent fanless'], sku:'USW-Lite-8-POE (52W)', price:'$110', use:'Standard sites', warranty:'1-yr manufacturer', note:'Replacing other switch options.' },
  { id:'uswflex', name:'Ubiquiti Switch Flex Mini 5', cat:'net', img:'p36', status:['new'], compat:['V1','V2'], specs:['5-port 2.5G','PoE or USB-C powered','Compact'], sku:'USW-Flex-2.5G-5', price:'$40', use:'Small deployments', warranty:'1-yr manufacturer', note:'Replacing other switch options.' },
  { id:'asus', name:'Asus RT-AC66U Router', cat:'net', img:'p37', status:['legacy'], compat:['V1'], specs:['AC1750 dual-band','AiMesh · AiProtection'], sku:'RT-AC66U', price:'$120', use:'Legacy site router', warranty:'1-yr manufacturer', note:'Being replaced by Ubiquiti routers.' },

  { id:'litebs', name:'Cluster Lite Barcode Scanner', cat:'periph', img:'p39', status:[], compat:['V1'], specs:['CMOS 1D / 2D','QR reader for kiosk','Black'], sku:'CLU-LIT-BS', price:'$90', use:'Kiosk & counter scanning', warranty:'1-yr manufacturer', note:'' },
  { id:'hpscan', name:'HP Engage Premium Scanner + Stand', cat:'periph', img:'p40', status:[], compat:['V1','V2'], specs:['1D / 2D imager','USB','Includes stand'], sku:'CLU-HP-PRE-SCA', price:'$180', use:'Counter scanning', warranty:'1-yr manufacturer', note:'Kaizen compatible.' },
  { id:'zebra', name:'Zebra DS9308 Countertop Scanner', cat:'periph', img:'p41', status:['eol'], compat:['V1'], specs:['Digimarc · 2D / 1D · OCR','Corded'], sku:'DS9308-SR4U2100AZW', price:'$150', use:'Counter scanning', warranty:'1-yr manufacturer', note:'Not reordering once stock is depleted.' },
  { id:'datalogic', name:'Datalogic QuickScan Wireless', cat:'periph', img:'p42', status:[], compat:['V1'], specs:['Bluetooth · 1D linear','RS232 · KBW · USB','Charging cradle'], sku:'QD2430-BKK1', price:'$210', use:'Mobile scanning', warranty:'1-yr manufacturer', note:'' },
  { id:'finger', name:'Fingerprint Reader', cat:'periph', img:'p43', status:[], compat:['V1'], specs:['Optical scan · USB 2.0','8-bit grayscale','Small form factor'], sku:'88003-001-S03', price:'$60', use:'Staff clock-in / auth', warranty:'1-yr manufacturer', note:'' },
  { id:'msr', name:'Custom America 3-Track MSR (Ascent)', cat:'periph', img:'p45', status:['new'], compat:['V1'], specs:['Magnetic stripe reader','For Ascent POS'], sku:'938KY460000002', price:'$55', use:'Card swipe on Ascent', warranty:'1-yr manufacturer', note:'' },
  { id:'magtek', name:'MagTek Dynamag Card Reader', cat:'periph', img:'p46', status:[], compat:['V1'], specs:['Triple-track MSR','6ft USB · 5V','Black'], sku:'21073062', price:'$70', use:'Card swipe', warranty:'1-yr manufacturer', note:'' },
  { id:'bump', name:'Logic Controls KB1700 Bump Bar', cat:'periph', img:'p47', status:[], compat:['V1','V2'], specs:['KDS bump bar','Legend Sheet B','Plastic / stainless'], sku:'LOG-KB1700UB-BK', price:'$130', use:'KDS navigation', warranty:'1-yr manufacturer', note:'Supported on the Kaizen KDS.' },
  { id:'scale', name:'Avery Brecknell 6720U POS Scale', cat:'periph', img:'p48', status:[], compat:['V1'], specs:['15kg × 0.005 / 30lb × 0.01','12×14" platter','Cable · display'], sku:'816965005901', price:'$260', use:'Weighed items', warranty:'1-yr manufacturer', note:'' },
  { id:'ssd', name:'Kingston 120GB SSD', cat:'periph', img:'p49', status:[], compat:['V1'], specs:['120GB SATA SSD','2.5" drive'], sku:'SA400S37/120G', price:'$35', use:'Terminal storage upgrade', warranty:'3-yr manufacturer', note:'' },

  { id:'cashblack', name:'Cash Drawer (Black)', cat:'cash', img:'p51', status:[], compat:['V1'], specs:['Standard till','Black'], sku:'CAS-DRA', price:'$110', use:'Cash handling', warranty:'1-yr manufacturer', note:'' },
  { id:'cashwhite', name:'Lite Cash Drawer — White (2023)', cat:'cash', img:'p52', status:[], compat:['V1'], specs:['Standard till','White'], sku:'CLU-LIT-CD-2023', price:'$115', use:'Cash handling', warranty:'1-yr manufacturer', note:'' },
];

module.exports = { categories, products, imgJpg };
