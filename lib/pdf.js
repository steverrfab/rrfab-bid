'use strict';
const PDFDocument = require('pdfkit');

const COMPANY = {
  name: 'R&R FABRICATION',
  tagline: 'Steel Fabrication + Erection',
  address: 'Prince Frederick, MD',
  phone: '301-855-9111',
  email: 'office@rrfabrication.org'
};

const DEFAULT_TERMS = [
  'Proposal valid 30 days from date of issue. Pricing subject to material market conditions at time of order.',
  'Payment: Net 30 from invoice date. Retainage per contract. 1.5% per month on past-due balances.',
  'Lead time: 4-6 weeks from approved shop drawings to delivery.',
  'Assumes standard M-F daytime access (7am-5pm). OT / weekend work priced separately.'
];

function fmt(n) {
  const v = Math.round(+n || 0);
  return '$' + v.toLocaleString('en-US');
}

function markupFactor(e) {
  return (1 + (+e.oh_rate || 0))
       * (1 + (+e.contingency_rate || 0))
       * (1 + (+e.profit_rate || 0))
       * (1 + (+e.cgl_rate || 0));
}

// Build the proposal PDF. Assumes doc is already created (piped or buffered).
function writeProposalToDoc(doc, bundle) {
  const { estimate: e, computed: c, extras = [], standardExclusions = [], siteExclusions = [] } = bundle;
  const mf = markupFactor(e);

  // -----------------------------------------------------------------------
  // PAGE 1: Header / Metadata / Scope / Pricing
  // -----------------------------------------------------------------------

  // Company header
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#1a1a1a').text(COMPANY.name);
  doc.font('Helvetica').fontSize(9).fillColor('#555')
     .text(COMPANY.tagline + '   ' + COMPANY.address + '   ' + COMPANY.phone + '   ' + COMPANY.email);
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#1a1a1a').lineWidth(1.5).stroke();
  doc.moveDown(0.8);

  // PROPOSAL title
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a1a').text('PROPOSAL', { characterSpacing: 3 });
  doc.moveDown(0.8);

  // Metadata grid (manual positioning so it stays aligned)
  const metaY = doc.y;
  const col1x = 50;
  const col1val = 115;
  const col2x = 310;
  const col2val = 360;
  const rowH = 16;

  function metaLabel(text, x, y) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555').text(text, x, y, { lineBreak: false });
  }
  function metaValue(text, x, y) {
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a').text(text || '', x, y, { lineBreak: false });
  }

  metaLabel('TO:', col1x, metaY);
  metaValue(e.proposal_to || e.client_gc || '', col1val, metaY);
  metaLabel('BID #:', col2x, metaY);
  metaValue(e.bid_number || '', col2val, metaY);

  metaLabel('PROJECT:', col1x, metaY + rowH);
  metaValue(e.project_name || '', col1val, metaY + rowH);

  const proposalDate = e.submitted_at
    ? new Date(e.submitted_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US')
    : (e.bid_date || '');
  metaLabel('DATE:', col2x, metaY + rowH);
  metaValue(proposalDate, col2val, metaY + rowH);

  doc.y = metaY + rowH + 22;

  // Section header helper
  function sectionHdr(text) {
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#777')
       .text(text.toUpperCase(), { characterSpacing: 1.2, lineBreak: false });
    const lineY = doc.y + 3;
    doc.moveTo(50, lineY).lineTo(562, lineY).strokeColor('#ccc').lineWidth(0.5).stroke();
    doc.y = lineY + 6;
  }

  // Scope of work
  sectionHdr('Scope of Work');
  const scopeText = e.proposal_scope || e.scope || '';
  if (scopeText) {
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a')
       .text(scopeText, { paragraphGap: 3, lineGap: 1 });
  }

  // Pricing table
  sectionHdr('Pricing');

  const colNum = 50;
  const colDesc = 80;
  const colAmt = 470;
  const colAmtW = 92;

  // Table header row
  const thY = doc.y;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#777');
  doc.text('#', colNum, thY, { lineBreak: false });
  doc.text('DESCRIPTION', colDesc, thY, { lineBreak: false });
  doc.text('AMOUNT', colAmt, thY, { width: colAmtW, align: 'right', lineBreak: false });
  doc.y = thY + 13;
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#999').lineWidth(0.5).stroke();
  doc.y += 5;

  // Build line items
  const defaultLineDescs = [
    'Structural steel material - furnished',
    'Shop fabrication and finishes',
    'Detailing and PE-stamped shop drawings',
    'Freight to jobsite',
    'Field erection, equipment, rigging',
    'Finishes',
    'Processing labor'
  ];

  function lineDesc(n) {
    return (e['proposal_line_' + n + '_desc'] || '').trim() || defaultLineDescs[n - 1];
  }

  const coreItems = [
    [1, lineDesc(1), c.materialPrice * mf],
    [2, lineDesc(2), (c.fabHours + c.paint + c.consumables + c.handling) * mf],
    [3, lineDesc(3), ((+e.struct_detailing || 0) + (+e.misc_detailing || 0) + (+e.pe_stamp || 0)) * mf],
    [4, lineDesc(4), (+e.freight || 0) * mf],
    [5, lineDesc(5), (c.erectionLabor + (+e.erection_equip || 0)) * mf],
    [6, lineDesc(6), c.galv * mf],
    [7, lineDesc(7), c.processingLabor * mf]
  ];

  // Subcontractor line items (only shown if > 0)
  const subItems = [];
  if ((+e.sub_joist_deck || 0) > 0) subItems.push(['Joist and Deck - by Sub', (+e.sub_joist_deck || 0) * mf]);
  if ((+e.sub_erection || 0) > 0)  subItems.push(['Erection - by Sub',          (+e.sub_erection || 0) * mf]);

  // Extras visible in the proposal: all sections
  const extraItems = extras.map((x) => {
    const amt = (+x.qty || 0) * (+x.rate || 0) * mf;
    return [x.description || 'Additional item', amt];
  });

  const allItems = [
    ...coreItems.map(([, label, amt]) => [label, amt]),
    ...subItems,
    ...extraItems
  ];
  let lineNum = 0;
  for (const [label, amount] of allItems) {
    lineNum++;
    const ry = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a')
       .text(String(lineNum), colNum, ry, { lineBreak: false });
    doc.text(label, colDesc, ry, { width: colAmt - colDesc - 10, lineBreak: false });
    doc.text(fmt(amount), colAmt, ry, { width: colAmtW, align: 'right', lineBreak: false });
    doc.y = ry + 16;
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#eee').lineWidth(0.3).stroke();
    doc.y += 3;
  }

  // Subtotal / Tax / Total
  doc.moveDown(0.3);
  doc.moveTo(380, doc.y).lineTo(562, doc.y).strokeColor('#999').lineWidth(0.5).stroke();
  doc.moveDown(0.35);

  function totRow(label, amount, bold) {
    const ry = doc.y;
    const font = bold ? 'Helvetica-Bold' : 'Helvetica';
    const size = bold ? 11 : 10;
    doc.font(font).fontSize(size).fillColor('#1a1a1a')
       .text(label, colDesc, ry, { lineBreak: false });
    doc.font(font).fontSize(size).fillColor('#1a1a1a')
       .text(fmt(amount), colAmt, ry, { width: colAmtW, align: 'right', lineBreak: false });
    doc.y = ry + (bold ? 17 : 15);
  }

  totRow('SUBTOTAL', c.totalBid, false);
  const taxPct = ((+e.sales_tax_rate || 0) * 100).toFixed(1);
  totRow('Sales Tax (' + taxPct + '%)', c.tax.amount, false);

  doc.moveTo(380, doc.y).lineTo(562, doc.y).strokeColor('#1a1a1a').lineWidth(1).stroke();
  doc.moveDown(0.35);

  const totalY = doc.y;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a1a')
     .text('TOTAL - FURNISH + INSTALL', colDesc, totalY, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a1a')
     .text(fmt(c.totalFurnishInstall), colAmt, totalY, { width: colAmtW, align: 'right', lineBreak: false });
  doc.y = totalY + 20;

  // -----------------------------------------------------------------------
  // PAGE 2: Exclusions / Terms / Open RFIs / Signature
  // -----------------------------------------------------------------------
  doc.addPage();

  // Company name on page 2 (slim)
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text(COMPANY.name);
  doc.font('Helvetica').fontSize(8).fillColor('#777')
     .text(COMPANY.tagline + '   ' + COMPANY.phone);
  doc.moveTo(50, doc.y + 4).lineTo(562, doc.y + 4).strokeColor('#1a1a1a').lineWidth(0.5).stroke();
  doc.y += 10;

  // EXCLUSIONS
  sectionHdr('Exclusions');

  // Site-specific exclusions sub-section
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text('Site Specific Exclusions:');
  doc.moveDown(0.3);
  if (siteExclusions.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor('#999').text('None noted.', { indent: 12 });
  } else {
    for (const ex of siteExclusions) {
      const ey = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a')
         .text('•  ' + (ex.text || ''), { indent: 12, lineGap: 1 });
    }
  }
  doc.moveDown(0.6);

  // Standard exclusions sub-section
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text('Standard Exclusions:');
  doc.moveDown(0.3);
  const activeStd = standardExclusions.filter(x => x.active !== 0);
  if (activeStd.length === 0) {
    doc.font('Helvetica').fontSize(9).fillColor('#999').text('None.', { indent: 12 });
  } else {
    for (const ex of activeStd) {
      doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a')
         .text('•  ' + (ex.text || ''), { indent: 12, lineGap: 1 });
    }
  }

  // TERMS + CONDITIONS
  sectionHdr('Terms + Conditions');
  const termsText = (e.proposal_terms || '').trim();
  if (termsText) {
    // User-supplied terms (legacy text blob)
    doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a').text(termsText, { paragraphGap: 2, lineGap: 2 });
  } else {
    DEFAULT_TERMS.forEach((term, i) => {
      const ry = doc.y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a1a')
         .text(String(i + 1) + '.', 50, ry, { width: 16, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a')
         .text(term, 68, ry, { width: 494, lineGap: 1 });
      doc.moveDown(0.3);
    });
  }

  // OPEN RFIs
  sectionHdr('Open RFIs');
  doc.font('Helvetica').fontSize(9).fillColor('#999')
     .text('No open RFIs at time of proposal.', { indent: 0 });
  doc.moveDown(1.5);

  // SIGNATURE BLOCK
  const sigY = Math.min(doc.y, 680); // keep on same page
  const sigCol1 = 50;
  const sigCol2 = 320;

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text('Submitted by:', sigCol1, sigY);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a')
     .text('Accepted by:', sigCol2, sigY);

  const sigLineY = sigY + 36;
  doc.moveTo(sigCol1, sigLineY).lineTo(sigCol1 + 230, sigLineY)
     .strokeColor('#333').lineWidth(0.5).stroke();
  doc.moveTo(sigCol2, sigLineY).lineTo(sigCol2 + 242, sigLineY)
     .strokeColor('#333').lineWidth(0.5).stroke();

  const submittedBy = (e.proposal_submitted_by || e.prepared_by || '').trim();
  if (submittedBy) {
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a')
       .text(submittedBy, sigCol1, sigLineY - 14, { lineBreak: false });
  }

  doc.font('Helvetica').fontSize(8).fillColor('#777')
     .text('R&R Fabrication', sigCol1, sigLineY + 4);
  doc.font('Helvetica').fontSize(8).fillColor('#777')
     .text('Name / Title / Date', sigCol2, sigLineY + 4);

  doc.end();
}

function generateProposal(res, bundle) {
  const { estimate: e } = bundle;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
    Title: 'Proposal ' + (e.bid_number || e.id),
    Author: COMPANY.name,
    Subject: e.project_name || 'R&R Bid Proposal'
  }});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    'attachment; filename="Proposal_' + (e.bid_number || e.id) + '.pdf"');
  doc.pipe(res);
  writeProposalToDoc(doc, bundle);
}

function generateProposalBuffer(bundle) {
  return new Promise((resolve, reject) => {
    try {
      const { estimate: e } = bundle;
      const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
        Title: 'Proposal ' + (e.bid_number || e.id),
        Author: COMPANY.name,
        Subject: e.project_name || 'R&R Bid Proposal'
      }});
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      writeProposalToDoc(doc, bundle);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateProposal, generateProposalBuffer };
