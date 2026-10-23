/**
 * DEMO DATASET
 * ------------
 * This file is only ever loaded when VITE_DATA_MODE=demo. It exists so the
 * product can be reviewed, tested and demoed without a Supabase project.
 *
 * Every record here is fictional and is clearly labelled as demo data in the
 * UI (persistent "Demo data" banner). The live adapter never imports this
 * module — production databases start empty, and the app shows real empty
 * states rather than invented numbers.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Seed records are plain JSON objects; loose typing here keeps the fixture
// readable and does not leak into the application's domain types.
type Row = Record<string, any>;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ts = (d: Date) => d.toISOString();
const daysFromNow = (n: number, hour = 10, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const monthStart = (offset: number) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
};
const monthEnd = (offset: number) => {
  const d = monthStart(offset + 1);
  d.setDate(0);
  return d;
};

export interface DemoUser {
  id: string;
  email: string;
  password: string;
  profile: Row;
}

export interface DemoDataset {
  users: DemoUser[];
  codes: Row[];
  tables: Record<string, Row[]>;
}

export function buildDemoDataset(): DemoDataset {
  const now = new Date();

  const users: DemoUser[] = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'admin@managedbyluna.com',
      password: 'luna-demo-admin',
      profile: {
        id: '00000000-0000-4000-8000-000000000001',
        role: 'admin',
        full_name: 'Luna — Studio Admin',
        email: 'admin@managedbyluna.com',
        phone: '+91 90000 00001',
        avatar_url: null,
        client_id: null,
        theme: 'dark',
        timezone: 'Asia/Kolkata',
        is_active: true,
        last_seen_at: ts(now),
        created_at: ts(monthStart(-14)),
        updated_at: ts(now),
      },
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      email: 'priya@prismstudio.in',
      password: 'demo-client-priya',
      profile: {
        id: '00000000-0000-4000-8000-000000000002',
        role: 'client',
        full_name: 'Priya Raghav',
        email: 'priya@prismstudio.in',
        phone: '+91 90000 00002',
        avatar_url: null,
        client_id: 'c1000000-0000-4000-8000-000000000001',
        theme: 'dark',
        timezone: 'Asia/Kolkata',
        is_active: true,
        last_seen_at: ts(daysFromNow(-2, 18)),
        created_at: ts(monthStart(-11)),
        updated_at: ts(now),
      },
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      email: 'ananya@anselco.in',
      password: 'demo-client-ananya',
      profile: {
        id: '00000000-0000-4000-8000-000000000003',
        role: 'client',
        full_name: 'Ananya Sen',
        email: 'ananya@anselco.in',
        phone: '+91 90000 00003',
        avatar_url: null,
        client_id: 'c1000000-0000-4000-8000-000000000002',
        theme: 'system',
        timezone: 'Asia/Kolkata',
        is_active: true,
        last_seen_at: ts(daysFromNow(-6, 11)),
        created_at: ts(monthStart(-9)),
        updated_at: ts(now),
      },
    },
  ];

  const clients: Row[] = [
    {
      id: 'c1000000-0000-4000-8000-000000000001',
      name: 'Prism Studio',
      business_name: 'Prism Studio LLP',
      contact_person: 'Priya Raghav',
      email: 'priya@prismstudio.in',
      phone: '+91 90000 00002',
      client_code: 'PR103',
      status: 'active',
      internal_notes: 'Prefers WhatsApp for approvals. Invoice on the 1st, expects PDF by the 3rd.',
      portal_status: 'active',
      address: '4th Floor, Indiranagar, Bengaluru 560038',
      created_at: ts(monthStart(-11)),
      updated_at: ts(daysFromNow(-3)),
    },
    {
      id: 'c1000000-0000-4000-8000-000000000002',
      name: 'Ansel & Co.',
      business_name: 'Ansel & Co. Interiors',
      contact_person: 'Ananya Sen',
      email: 'ananya@anselco.in',
      phone: '+91 90000 00003',
      client_code: 'ANS005',
      status: 'active',
      internal_notes: 'Quarterly retainer, renews in January. Photography invoiced separately.',
      portal_status: 'active',
      address: 'Salt Lake Sector 2, Kolkata 700091',
      created_at: ts(monthStart(-9)),
      updated_at: ts(daysFromNow(-1)),
    },
    {
      id: 'c1000000-0000-4000-8000-000000000003',
      name: 'Northline Coffee',
      business_name: 'Northline Coffee Roasters',
      contact_person: 'Rahul Menon',
      email: 'rahul@northlinecoffee.com',
      phone: '+91 90000 00004',
      client_code: 'NOR412',
      status: 'active',
      internal_notes: 'Seasonal campaigns — heavier spend Sept–Dec.',
      portal_status: 'none',
      address: 'Panampilly Nagar, Kochi 682036',
      created_at: ts(monthStart(-6)),
      updated_at: ts(daysFromNow(-9)),
    },
    {
      id: 'c1000000-0000-4000-8000-000000000004',
      name: 'Kavi Ayurveda',
      business_name: 'Kavi Ayurveda Pvt Ltd',
      contact_person: 'Meera Kavi',
      email: 'meera@kaviayurveda.in',
      phone: '+91 90000 00005',
      client_code: 'KAV220',
      status: 'inactive',
      internal_notes: 'Paused after brand launch. Reactivate for retainer in Q3.',
      portal_status: 'revoked',
      address: null,
      created_at: ts(monthStart(-18)),
      updated_at: ts(daysFromNow(-45)),
    },
    {
      id: 'c1000000-0000-4000-8000-000000000005',
      name: 'Vellum Legal',
      business_name: 'Vellum Legal Advisors',
      contact_person: 'Arjun Verma',
      email: 'arjun@vellumlegal.in',
      phone: '+91 90000 00006',
      client_code: 'VEL901',
      status: 'active',
      internal_notes: 'Compliance-sensitive: no copy ships without their review.',
      portal_status: 'active',
      address: 'Connaught Place, New Delhi 110001',
      created_at: ts(monthStart(-4)),
      updated_at: ts(daysFromNow(-2)),
    },
  ];

  const services: Row[] = [
    { id: 's0000000-0000-4000-8000-000000000001', name: 'Website Development', description: 'Design + build of marketing sites.', category: 'Build', is_archived: false, created_at: ts(monthStart(-20)) },
    { id: 's0000000-0000-4000-8000-000000000002', name: 'Website Maintenance', description: 'Updates, backups, uptime checks.', category: 'Care', is_archived: false, created_at: ts(monthStart(-20)) },
    { id: 's0000000-0000-4000-8000-000000000003', name: 'Social Media Marketing', description: 'Content calendars, publishing, community.', category: 'Growth', is_archived: false, created_at: ts(monthStart(-20)) },
    { id: 's0000000-0000-4000-8000-000000000004', name: 'Meta Ads Management', description: 'Paid social strategy and spend management.', category: 'Growth', is_archived: false, created_at: ts(monthStart(-18)) },
    { id: 's0000000-0000-4000-8000-000000000005', name: 'Google Ads Management', description: 'Search + PMax campaigns.', category: 'Growth', is_archived: false, created_at: ts(monthStart(-18)) },
    { id: 's0000000-0000-4000-8000-000000000006', name: 'SEO', description: 'Technical + on-page + content ops.', category: 'Growth', is_archived: false, created_at: ts(monthStart(-16)) },
    { id: 's0000000-0000-4000-8000-000000000007', name: 'Graphic Design', description: 'Print + digital design.', category: 'Creative', is_archived: false, created_at: ts(monthStart(-16)) },
    { id: 's0000000-0000-4000-8000-000000000008', name: 'Branding', description: 'Identity systems.', category: 'Creative', is_archived: false, created_at: ts(monthStart(-16)) },
    { id: 's0000000-0000-4000-8000-000000000009', name: 'Photography', description: 'Product and space photography.', category: 'Creative', is_archived: false, created_at: ts(monthStart(-14)) },
    { id: 's0000000-0000-4000-8000-00000000000a', name: 'Video Editing', description: 'Short-form and long-form edits.', category: 'Creative', is_archived: false, created_at: ts(monthStart(-14)) },
    { id: 's0000000-0000-4000-8000-00000000000b', name: 'Content Creation', description: 'Copy, blogs, captions.', category: 'Creative', is_archived: false, created_at: ts(monthStart(-12)) },
    { id: 's0000000-0000-4000-8000-00000000000c', name: 'Consulting', description: 'Advisory retainers.', category: 'Advice', is_archived: false, created_at: ts(monthStart(-10)) },
  ];

  const clientServices: Row[] = [
    {
      id: 'cs000000-0000-4000-8000-000000000001',
      client_id: clients[0].id, service_id: services[2].id,
      title: 'Social retainer — Instagram + LinkedIn',
      description: '16 posts, 8 reels, monthly reporting.',
      price_minor: 4500000, billing_type: 'monthly', billing_frequency_label: null,
      start_date: iso(monthStart(-8)), end_date: null, status: 'active',
      internal_notes: 'Renewed at ₹45,000 from this quarter.',
      client_notes: 'Includes 2 revision rounds per asset.',
      created_at: ts(monthStart(-8)), updated_at: ts(monthStart(-1)),
    },
    {
      id: 'cs000000-0000-4000-8000-000000000002',
      client_id: clients[0].id, service_id: services[1].id,
      title: 'Website care plan',
      description: 'Monthly backups, security patching, uptime monitoring.',
      price_minor: 800000, billing_type: 'monthly', billing_frequency_label: null,
      start_date: iso(monthStart(-6)), end_date: null, status: 'active',
      internal_notes: null, client_notes: 'Covers up to 2 hours of content edits per month.',
      created_at: ts(monthStart(-6)), updated_at: ts(monthStart(-6)),
    },
    {
      id: 'cs000000-0000-4000-8000-000000000003',
      client_id: clients[1].id, service_id: services[0].id,
      title: 'Interiors portfolio site',
      description: 'Design, build, CMS handover.',
      price_minor: 18000000, billing_type: 'one_time', billing_frequency_label: null,
      start_date: iso(monthStart(-5)), end_date: iso(monthStart(-1)), status: 'completed',
      internal_notes: 'Final handover signed off.',
      client_notes: 'Includes 30 days post-launch support.',
      created_at: ts(monthStart(-5)), updated_at: ts(monthStart(-1)),
    },
    {
      id: 'cs000000-0000-4000-8000-000000000004',
      client_id: clients[1].id, service_id: services[6].id,
      title: 'Quarterly design retainer',
      description: 'Lookbooks, print collateral, packaging.',
      price_minor: 3000000, billing_type: 'quarterly', billing_frequency_label: null,
      start_date: iso(monthStart(-6)), end_date: null, status: 'active',
      internal_notes: null, client_notes: 'One campaign per quarter.',
      created_at: ts(monthStart(-6)), updated_at: ts(monthStart(-6)),
    },
    {
      id: 'cs000000-0000-4000-8000-000000000005',
      client_id: clients[2].id, service_id: services[3].id,
      title: 'Meta ads — always on',
      description: 'Prospecting + retention campaigns.',
      price_minor: 3500000, billing_type: 'monthly', billing_frequency_label: null,
      start_date: iso(monthStart(-4)), end_date: null, status: 'active',
      internal_notes: 'Client handles creative briefs in-house.',
      client_notes: 'Media spend billed separately at actuals.',
      created_at: ts(monthStart(-4)), updated_at: ts(monthStart(-1)),
    },
    {
      id: 'cs000000-0000-4000-8000-000000000006',
      client_id: clients[2].id, service_id: services[8].id,
      title: 'Seasonal photography',
      description: 'Two shoot days, 40 edited frames.',
      price_minor: 6000000, billing_type: 'one_time', billing_frequency_label: null,
      start_date: iso(daysFromNow(-20)), end_date: iso(daysFromNow(10)), status: 'active',
      internal_notes: 'Studio booked for the second day.',
      client_notes: null,
      created_at: ts(daysFromNow(-24)), updated_at: ts(daysFromNow(-4)),
    },
    {
      id: 'cs000000-0000-4000-8000-000000000007',
      client_id: clients[3].id, service_id: services[7].id,
      title: 'Brand identity',
      description: 'Logo, palette, type system, guidelines.',
      price_minor: 12000000, billing_type: 'one_time', billing_frequency_label: null,
      start_date: iso(monthStart(-10)), end_date: iso(monthStart(-7)), status: 'completed',
      internal_notes: null, client_notes: null,
      created_at: ts(monthStart(-10)), updated_at: ts(monthStart(-7)),
    },
    {
      id: 'cs000000-0000-4000-8000-000000000008',
      client_id: clients[4].id, service_id: services[5].id,
      title: 'SEO + content programme',
      description: 'Technical fixes, 6 articles per month.',
      price_minor: 5500000, billing_type: 'monthly', billing_frequency_label: null,
      start_date: iso(monthStart(-3)), end_date: null, status: 'active',
      internal_notes: 'Legal review adds ~4 days to publishing.',
      client_notes: 'Publishing cadence: 1 article per week.',
      created_at: ts(monthStart(-3)), updated_at: ts(daysFromNow(-2)),
    },
    {
      id: 'cs000000-0000-4000-8000-000000000009',
      client_id: clients[4].id, service_id: services[0].id,
      title: 'Practice microsite',
      description: 'Single-page microsite with enquiry routing.',
      price_minor: 9000000, billing_type: 'custom', billing_frequency_label: '3 milestones',
      start_date: iso(daysFromNow(-12)), end_date: iso(daysFromNow(30)), status: 'active',
      internal_notes: 'Milestone 1 invoiced, 2 and 3 to follow.',
      client_notes: null,
      created_at: ts(daysFromNow(-12)), updated_at: ts(daysFromNow(-2)),
    },
  ];

  const projects: Row[] = [
    {
      id: 'p0000000-0000-4000-8000-000000000001',
      client_id: clients[0].id, client_service_id: clientServices[0].id,
      name: 'Q4 social calendar',
      description: 'Festive campaign arc across Instagram and LinkedIn.',
      status: 'in_progress', progress: 62,
      start_date: iso(monthStart(-1)), due_date: iso(daysFromNow(12)),
      client_visible: true, created_at: ts(monthStart(-1)), updated_at: ts(daysFromNow(-1)),
    },
    {
      id: 'p0000000-0000-4000-8000-000000000002',
      client_id: clients[1].id, client_service_id: clientServices[3].id,
      name: 'Winter lookbook',
      description: 'Art direction, layout, print-ready files.',
      status: 'review', progress: 84,
      start_date: iso(daysFromNow(-28)), due_date: iso(daysFromNow(6)),
      client_visible: true, created_at: ts(daysFromNow(-28)), updated_at: ts(daysFromNow(-1)),
    },
    {
      id: 'p0000000-0000-4000-8000-000000000003',
      client_id: clients[2].id, client_service_id: clientServices[5].id,
      name: 'Seasonal shoot — batch 2',
      description: 'Second shoot day, edit and retouch.',
      status: 'planning', progress: 20,
      start_date: iso(daysFromNow(-4)), due_date: iso(daysFromNow(10)),
      client_visible: false, created_at: ts(daysFromNow(-18)), updated_at: ts(daysFromNow(-3)),
    },
    {
      id: 'p0000000-0000-4000-8000-000000000004',
      client_id: clients[4].id, client_service_id: clientServices[8].id,
      name: 'Practice microsite v1',
      description: 'Design → build → QA → launch.',
      status: 'in_progress', progress: 45,
      start_date: iso(daysFromNow(-12)), due_date: iso(daysFromNow(24)),
      client_visible: true, created_at: ts(daysFromNow(-12)), updated_at: ts(daysFromNow(-2)),
    },
    {
      id: 'p0000000-0000-4000-8000-000000000005',
      client_id: clients[1].id, client_service_id: clientServices[2].id,
      name: 'Portfolio site launch',
      description: 'Delivered and handed over.',
      status: 'completed', progress: 100,
      start_date: iso(monthStart(-5)), due_date: iso(monthStart(-1)),
      client_visible: true, created_at: ts(monthStart(-5)), updated_at: ts(monthStart(-1)),
    },
  ];

  const projectUpdates: Row[] = [
    { id: 'pu000000-0000-4000-8000-000000000001', project_id: projects[0].id, title: 'Festive grid approved', body: 'First two weeks of the festive grid signed off. Reels are in edit.', client_visible: true, author_id: users[0].id, created_at: ts(daysFromNow(-2, 16)) },
    { id: 'pu000000-0000-4000-8000-000000000002', project_id: projects[1].id, title: 'Lookbook in review', body: 'Layout v3 shared for final notes. Print proof once approved.', client_visible: true, author_id: users[0].id, created_at: ts(daysFromNow(-1, 12)) },
    { id: 'pu000000-0000-4000-8000-000000000003', project_id: projects[3].id, title: 'Wireframes complete', body: 'Home + enquiry flow wireframed. Moving to visual design.', client_visible: true, author_id: users[0].id, created_at: ts(daysFromNow(-3, 17)) },
    { id: 'pu000000-0000-4000-8000-000000000004', project_id: projects[2].id, title: 'Internal: studio blocked', body: 'Second shoot day needs the studio confirmed before Friday.', client_visible: false, author_id: users[0].id, created_at: ts(daysFromNow(-3, 9)) },
    { id: 'pu000000-0000-4000-8000-000000000005', project_id: projects[4].id, title: 'Launch complete', body: 'Site live. Post-launch support window is open until the end of the month.', client_visible: true, author_id: users[0].id, created_at: ts(monthStart(-1)) },
  ];

  // ---- Billing: recurring services are invoiced period by period -----------
  const invoices: Row[] = [];
  const invoiceItems: Row[] = [];
  const payments: Row[] = [];
  const receipts: Row[] = [];

  let invoiceSeq = 0;
  let receiptSeq = 0;
  const addInvoice = (args: {
    clientService: Row;
    clientId: string;
    periodOffset: number;
    description: string;
    issueOffset: number;
    dueOffset: number;
    amountMinor: number;
    paidMinor: number;
    method?: string;
    reference?: string;
    paidOffset?: number;
    notes?: string;
    status?: string;
  }) => {
    invoiceSeq += 1;
    const id = `i0000000-0000-4000-8000-${String(invoiceSeq).padStart(12, '0')}`;
    const pStart = monthStart(args.periodOffset);
    const pEnd = monthEnd(args.periodOffset);
    invoices.push({
      id,
      invoice_number: `MBL-INV-${pStart.getFullYear()}-${String(invoiceSeq).padStart(4, '0')}`,
      client_id: args.clientId,
      client_service_id: args.clientService.id,
      billing_period_start: iso(pStart),
      billing_period_end: iso(pEnd),
      issue_date: iso(daysFromNow(args.issueOffset)),
      due_date: iso(daysFromNow(args.dueOffset)),
      subtotal_minor: args.amountMinor,
      discount_minor: 0,
      tax_minor: 0,
      total_minor: args.amountMinor,
      status: args.status ?? (args.paidMinor >= args.amountMinor ? 'paid' : args.paidMinor > 0 ? 'partially_paid' : 'pending'),
      notes: args.notes ?? null,
      created_at: ts(daysFromNow(args.issueOffset)),
      updated_at: ts(daysFromNow(-1)),
    });
    invoiceItems.push({
      id: `ii000000-0000-4000-8000-${String(invoiceSeq).padStart(12, '0')}`,
      invoice_id: id,
      description: args.description,
      quantity: 1,
      unit_price_minor: args.amountMinor,
      amount_minor: args.amountMinor,
      position: 0,
    });
    if (args.paidMinor > 0) {
      const payId = `pay00000-0000-4000-8000-${String(invoiceSeq).padStart(12, '0')}`;
      const paidAt = iso(daysFromNow(args.paidOffset ?? args.issueOffset + 2));
      payments.push({
        id: payId,
        client_id: args.clientId,
        invoice_id: id,
        amount_minor: args.paidMinor,
        paid_at: paidAt,
        method: args.method ?? 'upi',
        reference: args.reference ?? null,
        notes: null,
        voided_at: null,
        void_reason: null,
        created_by: users[0].id,
        created_at: ts(new Date(paidAt)),
      });
      receiptSeq += 1;
      receipts.push({
        id: `r0000000-0000-4000-8000-${String(receiptSeq).padStart(12, '0')}`,
        receipt_number: `MBL-RCP-${new Date(paidAt).getFullYear()}-${String(receiptSeq).padStart(4, '0')}`,
        payment_id: payId,
        client_id: args.clientId,
        invoice_id: id,
        issued_at: paidAt,
        snapshot: {},
        created_at: ts(new Date(paidAt)),
      });
    }
    return id;
  };

  // Prism Studio — social retainer, three periods with mixed states
  addInvoice({ clientService: clientServices[0], clientId: clients[0].id, periodOffset: -2, description: 'Social retainer — Instagram + LinkedIn', issueOffset: -62, dueOffset: -55, amountMinor: 4500000, paidMinor: 4500000, reference: 'UPI/4471902', paidOffset: -58 });
  addInvoice({ clientService: clientServices[0], clientId: clients[0].id, periodOffset: -1, description: 'Social retainer — Instagram + LinkedIn', issueOffset: -32, dueOffset: -25, amountMinor: 4500000, paidMinor: 3000000, reference: 'NEFT/PRISM/0921', paidOffset: -26, notes: 'Part payment received; balance promised next cycle.' });
  addInvoice({ clientService: clientServices[0], clientId: clients[0].id, periodOffset: 0, description: 'Social retainer — Instagram + LinkedIn', issueOffset: -2, dueOffset: 5, amountMinor: 4500000, paidMinor: 0 });
  addInvoice({ clientService: clientServices[1], clientId: clients[0].id, periodOffset: 0, description: 'Website care plan', issueOffset: -2, dueOffset: 5, amountMinor: 800000, paidMinor: 800000, method: 'bank_transfer', reference: 'NEFT/CARE/1004', paidOffset: -1 });

  // Ansel & Co. — one-time project, fully paid in two instalments
  addInvoice({ clientService: clientServices[2], clientId: clients[1].id, periodOffset: -4, description: 'Interiors portfolio site — milestone 1', issueOffset: -120, dueOffset: -113, amountMinor: 9000000, paidMinor: 9000000, method: 'bank_transfer', reference: 'NEFT/ANSEL/M1', paidOffset: -115 });
  addInvoice({ clientService: clientServices[2], clientId: clients[1].id, periodOffset: -1, description: 'Interiors portfolio site — final', issueOffset: -40, dueOffset: -33, amountMinor: 9000000, paidMinor: 9000000, method: 'bank_transfer', reference: 'NEFT/ANSEL/M2', paidOffset: -35 });
  addInvoice({ clientService: clientServices[3], clientId: clients[1].id, periodOffset: -1, description: 'Quarterly design retainer', issueOffset: -30, dueOffset: -20, amountMinor: 3000000, paidMinor: 0, notes: 'Awaiting confirmation of PO number.' });

  // Northline — monthly ads, one overdue
  addInvoice({ clientService: clientServices[4], clientId: clients[2].id, periodOffset: -1, description: 'Meta ads — always on', issueOffset: -34, dueOffset: -27, amountMinor: 3500000, paidMinor: 3500000, reference: 'UPI/9902114', paidOffset: -28 });
  addInvoice({ clientService: clientServices[4], clientId: clients[2].id, periodOffset: 0, description: 'Meta ads — always on', issueOffset: -6, dueOffset: -1, amountMinor: 3500000, paidMinor: 0, status: 'overdue' });

  // Vellum Legal — SEO retainer, current period part paid
  addInvoice({ clientService: clientServices[7], clientId: clients[4].id, periodOffset: -1, description: 'SEO + content programme', issueOffset: -31, dueOffset: -24, amountMinor: 5500000, paidMinor: 5500000, method: 'bank_transfer', reference: 'NEFT/VELLUM/3310', paidOffset: -25 });
  addInvoice({ clientService: clientServices[7], clientId: clients[4].id, periodOffset: 0, description: 'SEO + content programme', issueOffset: -2, dueOffset: 6, amountMinor: 5500000, paidMinor: 2500000, reference: 'UPI/5512308', paidOffset: -1 });

  // Kavi — historical, unpaid legacy invoice kept for the record
  addInvoice({ clientService: clientServices[6], clientId: clients[3].id, periodOffset: -8, description: 'Brand identity — final milestone', issueOffset: -240, dueOffset: -230, amountMinor: 4000000, paidMinor: 0, status: 'overdue', notes: 'Account paused; balance under discussion.' });

  // Fill receipt snapshots from the invoice/payment records so reprints are honest.
  for (const r of receipts) {
    const inv = invoices.find((i) => i.id === r.invoice_id)!;
    const cl = clients.find((c) => c.id === r.client_id)!;
    const p = payments.find((x) => x.id === r.payment_id)!;
    const priorPaid = payments
      .filter((x) => x.invoice_id === r.invoice_id && !x.voided_at && x.id !== r.payment_id)
      .reduce((a, b) => a + Number(b.amount_minor), 0);
    r.snapshot = {
      receipt_number: r.receipt_number,
      invoice_number: inv.invoice_number,
      issue_date: r.issued_at,
      client_name: cl.name,
      client_business: cl.business_name,
      client_email: cl.email,
      client_phone: cl.phone,
      items: [{ description: invoiceItems.find((i) => i.invoice_id === inv.id)?.description ?? 'Services', amount_minor: inv.total_minor }],
      billing_period: `${inv.billing_period_start} → ${inv.billing_period_end}`,
      invoice_total_minor: inv.total_minor,
      previously_paid_minor: priorPaid,
      amount_received_minor: p.amount_minor,
      balance_minor: Number(inv.total_minor) - priorPaid - Number(p.amount_minor),
      method: p.method,
      reference: p.reference,
      payment_date: p.paid_at,
      payment_status: inv.status,
      notes: inv.notes,
      company: {
        company_name: 'Managed by Luna',
        logo_url: null,
        receipt_footer: 'Thank you for working with Managed by Luna.',
        contact_email: 'hello@managedbyluna.com',
        contact_phone: '+91 90000 00000',
        address: null,
        tax_id: null,
        tax_label: null,
      },
    };
  }

  const tasks: Row[] = [
    { id: 't0000000-0000-4000-8000-000000000001', owner_id: users[0].id, client_id: clients[0].id, project_id: projects[0].id, title: 'Approve festive reel edits', description: 'Two rounds of notes from Prism outstanding.', priority: 'high', category: 'Delivery', status: 'in_progress', due_date: iso(daysFromNow(1)), due_time: '11:00', completed_at: null, created_at: ts(daysFromNow(-6)), updated_at: ts(daysFromNow(-1)) },
    { id: 't0000000-0000-4000-8000-000000000002', owner_id: users[0].id, client_id: clients[2].id, project_id: projects[2].id, title: 'Confirm studio for shoot day 2', description: null, priority: 'urgent', category: 'Ops', status: 'todo', due_date: iso(daysFromNow(-1)), due_time: '18:00', completed_at: null, created_at: ts(daysFromNow(-8)), updated_at: ts(daysFromNow(-2)) },
    { id: 't0000000-0000-4000-8000-000000000003', owner_id: users[0].id, client_id: clients[1].id, project_id: projects[1].id, title: 'Send lookbook print proof', description: 'Use the Kochi printer — Ananya approved the quote.', priority: 'medium', category: 'Delivery', status: 'todo', due_date: iso(daysFromNow(3)), due_time: '15:00', completed_at: null, created_at: ts(daysFromNow(-3)), updated_at: ts(daysFromNow(-3)) },
    { id: 't0000000-0000-4000-8000-000000000004', owner_id: users[0].id, client_id: clients[2].id, project_id: null, title: 'Chase overdue Meta ads invoice', description: 'Northline — ₹35,000, 1 day past due.', priority: 'urgent', category: 'Finance', status: 'todo', due_date: iso(daysFromNow(0)), due_time: '17:00', completed_at: null, created_at: ts(daysFromNow(-1)), updated_at: ts(daysFromNow(-1)) },
    { id: 't0000000-0000-4000-8000-000000000005', owner_id: users[0].id, client_id: null, project_id: null, title: 'Quarterly tax documents to CA', description: null, priority: 'medium', category: 'Admin', status: 'todo', due_date: iso(daysFromNow(9)), due_time: null, completed_at: null, created_at: ts(daysFromNow(-10)), updated_at: ts(daysFromNow(-10)) },
    { id: 't0000000-0000-4000-8000-000000000006', owner_id: users[0].id, client_id: clients[4].id, project_id: projects[3].id, title: 'Wireframe review with Arjun', description: 'Legal review of enquiry flow copy.', priority: 'high', category: 'Delivery', status: 'completed', due_date: iso(daysFromNow(-2)), due_time: '10:30', completed_at: ts(daysFromNow(-2, 12)), created_at: ts(daysFromNow(-9)), updated_at: ts(daysFromNow(-2)) },
    { id: 't0000000-0000-4000-8000-000000000007', owner_id: users[0].id, client_id: clients[0].id, project_id: null, title: 'Monthly report — Prism', description: null, priority: 'low', category: 'Reporting', status: 'completed', due_date: iso(daysFromNow(-4)), due_time: null, completed_at: ts(daysFromNow(-4, 18)), created_at: ts(daysFromNow(-12)), updated_at: ts(daysFromNow(-4)) },
    { id: 't0000000-0000-4000-8000-000000000008', owner_id: users[0].id, client_id: null, project_id: null, title: 'Renew studio software licences', description: null, priority: 'low', category: 'Admin', status: 'todo', due_date: iso(daysFromNow(21)), due_time: null, completed_at: null, created_at: ts(daysFromNow(-20)), updated_at: ts(daysFromNow(-20)) },
    { id: 't0000000-0000-4000-8000-000000000009', owner_id: users[0].id, client_id: clients[1].id, project_id: null, title: 'Archive delivered portfolio files', description: null, priority: 'low', category: 'Ops', status: 'archived', due_date: null, due_time: null, completed_at: null, created_at: ts(monthStart(-3)), updated_at: ts(monthStart(-2)) },
    { id: 't0000000-0000-4000-8000-00000000000a', owner_id: users[1].id, client_id: clients[0].id, project_id: projects[0].id, title: 'Share festive product photos', description: 'Priya’s own task list — private to her account.', priority: 'medium', category: 'Content', status: 'todo', due_date: iso(daysFromNow(2)), due_time: '12:00', completed_at: null, created_at: ts(daysFromNow(-2)), updated_at: ts(daysFromNow(-2)) },
  ];

  const events: Row[] = [
    { id: 'e0000000-0000-4000-8000-000000000001', owner_id: users[0].id, client_id: clients[2].id, project_id: projects[2].id, task_id: null, title: 'Seasonal shoot — day 2', description: 'Studio + 2 models.', category: 'work', starts_at: ts(daysFromNow(4, 9)), ends_at: ts(daysFromNow(4, 18)), all_day: false, recurrence: 'none', recurrence_until: null, client_visible: false, created_at: ts(daysFromNow(-6)), updated_at: ts(daysFromNow(-6)) },
    { id: 'e0000000-0000-4000-8000-000000000002', owner_id: users[0].id, client_id: clients[0].id, project_id: projects[0].id, task_id: null, title: 'Prism monthly review call', description: null, category: 'meeting', starts_at: ts(daysFromNow(2, 16)), ends_at: ts(daysFromNow(2, 16, 45)), all_day: false, recurrence: 'monthly', recurrence_until: null, client_visible: true, created_at: ts(monthStart(-3)), updated_at: ts(monthStart(-3)) },
    { id: 'e0000000-0000-4000-8000-000000000003', owner_id: users[0].id, client_id: null, project_id: null, task_id: null, title: 'Invoice run', description: 'Issue recurring invoices for active retainers.', category: 'billing', starts_at: ts(daysFromNow(7, 10)), ends_at: ts(daysFromNow(7, 11)), all_day: false, recurrence: 'monthly', recurrence_until: null, client_visible: false, created_at: ts(monthStart(-6)), updated_at: ts(monthStart(-6)) },
    { id: 'e0000000-0000-4000-8000-000000000004', owner_id: users[0].id, client_id: clients[1].id, project_id: projects[1].id, task_id: null, title: 'Lookbook print deadline', description: null, category: 'deadline', starts_at: ts(daysFromNow(6, 0)), ends_at: ts(daysFromNow(6, 23, 59)), all_day: true, recurrence: 'none', recurrence_until: null, client_visible: true, created_at: ts(daysFromNow(-20)), updated_at: ts(daysFromNow(-20)) },
    { id: 'e0000000-0000-4000-8000-000000000005', owner_id: users[0].id, client_id: null, project_id: null, task_id: null, title: 'Deep work — no meetings', description: null, category: 'personal', starts_at: ts(daysFromNow(1, 9)), ends_at: ts(daysFromNow(1, 12)), all_day: false, recurrence: 'weekly', recurrence_until: null, client_visible: false, created_at: ts(monthStart(-8)), updated_at: ts(monthStart(-8)) },
    { id: 'e0000000-0000-4000-8000-000000000006', owner_id: users[0].id, client_id: clients[4].id, project_id: projects[3].id, task_id: null, title: 'Vellum design walkthrough', description: null, category: 'meeting', starts_at: ts(daysFromNow(9, 15)), ends_at: ts(daysFromNow(9, 16)), all_day: false, recurrence: 'none', recurrence_until: null, client_visible: true, created_at: ts(daysFromNow(-4)), updated_at: ts(daysFromNow(-4)) },
  ];

  const notes: Row[] = [
    { id: 'n0000000-0000-4000-8000-000000000001', owner_id: users[0].id, client_id: clients[1].id, scope: 'client', title: 'Ansel — print vendor notes', body: 'Kochi printer quoted ₹42/page for the lookbook, delivery in 4 days. Ananya prefers matte stock.', tags: ['print', 'vendor'], is_pinned: true, is_archived: false, created_at: ts(daysFromNow(-9)), updated_at: ts(daysFromNow(-2)) },
    { id: 'n0000000-0000-4000-8000-000000000002', owner_id: users[0].id, client_id: null, scope: 'agency', title: 'Q4 positioning draft', body: 'Lead with "one desk for the whole account". Avoid feature lists in the first paragraph.', tags: ['positioning'], is_pinned: true, is_archived: false, created_at: ts(daysFromNow(-14)), updated_at: ts(daysFromNow(-5)) },
    { id: 'n0000000-0000-4000-8000-000000000003', owner_id: users[0].id, client_id: clients[0].id, scope: 'client', title: 'Prism — approval loop', body: 'Priya signs off on WhatsApp; ask her to reply on email for the record.', tags: ['process'], is_pinned: false, is_archived: false, created_at: ts(daysFromNow(-30)), updated_at: ts(daysFromNow(-12)) },
    { id: 'n0000000-0000-4000-8000-000000000004', owner_id: users[0].id, client_id: null, scope: 'personal', title: 'Reading list', body: 'Positioning, pricing retainers, agency ops.', tags: ['reading'], is_pinned: false, is_archived: false, created_at: ts(daysFromNow(-40)), updated_at: ts(daysFromNow(-40)) },
    { id: 'n0000000-0000-4000-8000-000000000005', owner_id: users[0].id, client_id: null, scope: 'agency', title: 'Onboarding checklist v2', body: 'Kick-off call → brand assets → access → first sprint → review cadence.', tags: ['process', 'onboarding'], is_pinned: false, is_archived: true, created_at: ts(monthStart(-5)), updated_at: ts(monthStart(-3)) },
  ];

  const reminders: Row[] = [
    { id: 'rm000000-0000-4000-8000-000000000001', owner_id: users[0].id, task_id: tasks[0].id, title: 'Chase Prism reel approvals', description: 'Before the edit team rolls into next week.', remind_at: ts(daysFromNow(0, 9, 30)), repeat: 'none', repeat_until: null, alarm_enabled: true, is_dismissed: false, dismissed_at: null, snoozed_until: null, fired_at: null, created_at: ts(daysFromNow(-2)), updated_at: ts(daysFromNow(-2)) },
    { id: 'rm000000-0000-4000-8000-000000000002', owner_id: users[0].id, task_id: tasks[3].id, title: 'Invoice follow-up — Northline', description: null, remind_at: ts(daysFromNow(0, 17, 0)), repeat: 'none', repeat_until: null, alarm_enabled: true, is_dismissed: false, dismissed_at: null, snoozed_until: null, fired_at: null, created_at: ts(daysFromNow(-1)), updated_at: ts(daysFromNow(-1)) },
    { id: 'rm000000-0000-4000-8000-000000000003', owner_id: users[0].id, task_id: null, title: 'Weekly books review', description: 'Reconcile UPI payments against invoices.', remind_at: ts(daysFromNow(3, 18, 0)), repeat: 'weekly', repeat_until: null, alarm_enabled: false, is_dismissed: false, dismissed_at: null, snoozed_until: null, fired_at: null, created_at: ts(monthStart(-6)), updated_at: ts(monthStart(-6)) },
    { id: 'rm000000-0000-4000-8000-000000000004', owner_id: users[0].id, task_id: null, title: 'Missed: confirm studio booking', description: 'This one elapsed while the app was closed — shown as missed, not silently dropped.', remind_at: ts(daysFromNow(-1, 11, 0)), repeat: 'none', repeat_until: null, alarm_enabled: true, is_dismissed: false, dismissed_at: null, snoozed_until: null, fired_at: null, created_at: ts(daysFromNow(-3)), updated_at: ts(daysFromNow(-3)) },
  ];

  const notifications: Row[] = [
    { id: 'nt000000-0000-4000-8000-000000000001', user_id: users[0].id, kind: 'payment', title: 'Payment recorded — ₹25,000', body: 'Vellum Legal · SEO + content programme', link: '/admin/payments', dedupe_key: 'payment:pay-vel', read_at: null, created_at: ts(daysFromNow(-1, 14)) },
    { id: 'nt000000-0000-4000-8000-000000000002', user_id: users[0].id, kind: 'deadline', title: 'Lookbook deadline in 6 days', body: 'Ansel & Co. — Winter lookbook', link: '/admin/projects', dedupe_key: 'deadline:p2', read_at: null, created_at: ts(daysFromNow(-1, 9)) },
    { id: 'nt000000-0000-4000-8000-000000000003', user_id: users[0].id, kind: 'overdue_task', title: 'Task overdue: Confirm studio for shoot day 2', body: 'Northline Coffee', link: '/admin/tasks', dedupe_key: 'overdue:t2', read_at: ts(daysFromNow(-1, 10)), created_at: ts(daysFromNow(-1, 8)) },
    { id: 'nt000000-0000-4000-8000-000000000004', user_id: users[1].id, kind: 'announcement', title: 'Festive grid approved', body: 'The first two weeks are signed off — reels are in edit.', link: '/portal', dedupe_key: null, read_at: null, created_at: ts(daysFromNow(-2, 16)) },
  ];

  const stopwatchSessions: Row[] = [
    { id: 'sw000000-0000-4000-8000-000000000001', owner_id: users[0].id, label: 'Prism — reel edits', started_at: ts(daysFromNow(-1, 10)), ended_at: ts(daysFromNow(-1, 10, 52)), duration_ms: 3120000, laps: [600000, 1200000, 1320000], created_at: ts(daysFromNow(-1, 10, 52)) },
    { id: 'sw000000-0000-4000-8000-000000000002', owner_id: users[0].id, label: 'Vellum — wireframe QA', started_at: ts(daysFromNow(-2, 15)), ended_at: ts(daysFromNow(-2, 15, 24)), duration_ms: 1440000, laps: [], created_at: ts(daysFromNow(-2, 15, 24)) },
  ];

  const announcements: Row[] = [
    { id: 'an000000-0000-4000-8000-000000000001', client_id: clients[0].id, title: 'Studio closed 25–27 Oct', body: 'We are closed for Diwali. Scheduled reels will still publish; replies resume on the 28th.', published_at: ts(daysFromNow(-3)), expires_at: ts(daysFromNow(14)) },
  ];

  const branding: Row[] = [{
    id: 'b0000000-0000-4000-8000-000000000001',
    company_name: 'Managed by Luna',
    logo_url: null,
    receipt_footer: 'Thank you for working with Managed by Luna. This is a computer-generated receipt.',
    contact_email: 'hello@managedbyluna.com',
    contact_phone: '+91 90000 00000',
    address: null,
    tax_id: null,
    tax_label: null,
    receipt_prefix: 'MBL-RCP',
    invoice_prefix: 'MBL-INV',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    updated_at: ts(now),
  }];

  const accessCodes: Row[] = [
    { id: 'ac000000-0000-4000-8000-000000000001', user_id: users[1].id, client_id: clients[0].id, label: 'Prism Studio portal', is_revoked: false, last_used_at: ts(daysFromNow(-2)), uses_count: 14, created_at: ts(monthStart(-11)) },
    { id: 'ac000000-0000-4000-8000-000000000002', user_id: users[2].id, client_id: clients[1].id, label: 'Ansel & Co. portal', is_revoked: false, last_used_at: ts(daysFromNow(-6)), uses_count: 9, created_at: ts(monthStart(-9)) },
    { id: 'ac000000-0000-4000-8000-000000000003', user_id: null, client_id: clients[3].id, label: 'Kavi — revoked', is_revoked: true, last_used_at: ts(daysFromNow(-45)), uses_count: 3, created_at: ts(monthStart(-18)) },
  ];

  const prefs: Row[] = users.map((u) => ({
    user_id: u.id,
    browser_notifications: false,
    alarm_sound: true,
    alarm_volume: 0.6,
    alarm_sound_name: 'pulse',
    email_digest: false,
    quiet_hours_start: '22:00',
    quiet_hours_end: '08:00',
    updated_at: ts(now),
  }));

  const auditLogs: Row[] = [
    { id: 'au000000-0000-4000-8000-000000000001', actor_id: users[0].id, actor_label: 'Luna — Studio Admin', action: 'payment.recorded', entity: 'payments', entity_id: payments[payments.length - 1].id, before: null, after: { amount_minor: payments[payments.length - 1].amount_minor }, created_at: ts(daysFromNow(-1, 14)) },
    { id: 'au000000-0000-4000-8000-000000000002', actor_id: users[0].id, actor_label: 'Luna — Studio Admin', action: 'client.access.revoked', entity: 'clients', entity_id: clients[3].id, before: { portal_status: 'active' }, after: { portal_status: 'revoked' }, created_at: ts(daysFromNow(-45)) },
  ];

  return {
    users,
    codes: [
      { code: 'PR103', user_id: users[1].id, role: 'client' },
      { code: 'ANS005', user_id: users[2].id, role: 'client' },
    ],
    tables: {
      profiles: users.map((u) => u.profile),
      clients,
      services,
      client_services: clientServices,
      projects,
      project_updates: projectUpdates,
      invoices,
      invoice_items: invoiceItems,
      payments,
      receipts,
      tasks,
      calendar_events: events,
      notes,
      reminders,
      notifications,
      notification_preferences: prefs,
      stopwatch_sessions: stopwatchSessions,
      branding_settings: branding,
      audit_logs: auditLogs,
      announcements,
      client_access_codes: accessCodes,
      // Nothing is subscribed on a fresh install; rows appear only after the
      // user grants notification permission and a push endpoint is stored.
      push_subscriptions: [] as Row[],
    },
  };
}

/** Credentials surfaced *only* inside the demo build's sign-in helper panel. */
export const DEMO_CREDENTIALS = {
  adminCode: 'ADI000',
  adminEmail: 'admin@managedbyluna.com',
  adminPassword: 'luna-demo-admin',
  clientCodes: ['PR103', 'ANS005'],
};
