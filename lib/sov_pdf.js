'use strict';
const PDFDocument = require('pdfkit');

const COMPANY = {
  name: 'R&R FABRICATION',
  tagline: 'Steel Fabrication + Erection',
  phone: '301-855-9111'
};

function fmt(n) {
  const v = Math.round(+n || 0);
  return '$' + v.toLocaleString('en-US');
}

function pct(n, total) {
  if (!total) return '0.00%';
  return ((n / total) * 100).toFixed(2) + '%';
}

function writeSovToDoc(doc, bundle) {
  const { estimate: e, sovItems = [] } = bundle;

  const totalScheduled = sovItems.reduce((s, x) => s + (+x.scheduled_value || 0), 0);

  // ---- Header ----
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a1a1a').text(COMPANY.name);
  doc.font('Helvetica').fontSize(9).fillColor('#555')
     .text(COMPANY.tagline + '   ' + COMPANY.phone);
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#1a1a1a').lineWidth(1.5).stroke();
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a1a1a')
     .text('SCHEDULE OF VALUES', { characterSpacing: 2 });
  doc.font('Helvetica').fontSize(8).fillColor('#777')
     .text('AIA Document G703 — Application and Certificate for Payment');
  doc.moveDown(0.8);

  // ---- Project metadata ----
  const metaY = doc.y;
  const rowH = 16;

  function label(text, x, y) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text(text, x, y, { lineBreak: false });
  }
  function val(text, x, y, w) {
    doc.font('Helvetica').fontSize(9).fillColor('#1a1a1a').text(text || '', x, y, { lineBreak: false, width: w });
  }

  label('PROJECT:', 50, metaY);
  val(e.project_name || '', 105, metaY, 180);
  label('CONTRACT NO:', 310, metaY);
  val(e.bid_number || '', 385, metaY, 120);

  label('OWNER:', 50, metaY + rowH);
  val(e.client_gc || '', 105, metaY + rowH, 180);
  label('DATE:', 310, metaY + rowH);
  const wonDate = e.updated_at
    ? new Date(e.updated_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US')
    : '';
  val(wonDate, 385, metaY + rowH, 120);

  label('CONTRACTOR:', 50, metaY + rowH * 2);
  val(COMPANY.name, 105, metaY + rowH * 2, 180);

  doc.y = metaY + rowH * 2 + 24;

  // ---- Table ----
  const COL = {
    num:   { x: 50,  w: 34  },
    desc:  { x: 84,  w: 225 },
    sched: { x: 309, w: 85  },
    prev:  { x: 394, w: 60  },
    curr:  { x: 454, w: 60  },
    total: { x: 514, w: 48  }
  };

  // Table header
  const thY = doc.y;
  doc.rect(50, thY, 512, 16).fillColor('#1a1a1a').fill();
  doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff');
  doc.text('NO.',      COL.num.x + 2,  thY + 4, { lineBreak: false });
  doc.text('DESCRIPTION OF WORK', COL.desc.x + 2, thY + 4, { lineBreak: false });
  doc.text('SCHEDULED', COL.sched.x + 2, thY + 1, { lineBreak: false });
  doc.text('VALUE',     COL.sched.x + 2, thY + 8, { lineBreak: false });
  doc.text('PREV',      COL.prev.x + 2,  thY + 1, { lineBreak: false });
  doc.text('COMP.',     COL.prev.x + 2,  thY + 8, { lineBreak: false });
  doc.text('THIS PER.', COL.curr.x + 2,  thY + 1, { lineBreak: false });
  doc.text('',          COL.curr.x + 2,  thY + 8, { lineBreak: false });
  doc.text('% COMP.',   COL.total.x,     thY + 4, { lineBreak: false, width: COL.total.w, align: 'right' });
  doc.y = thY + 18;

  // Sub-header for $
  const shY = doc.y;
  doc.rect(50, shY, 512, 10).fillColor('#2a2a2a').fill();
  doc.font('Helvetica').fontSize(6.5).fillColor('#ccc');
  doc.text('(a)', COL.num.x + 2, shY + 2, { lineBreak: false });
  doc.text('(b)', COL.desc.x + 2, shY + 2, { lineBreak: false });
  doc.text('(c)', COL.sched.x + 2, shY + 2, { lineBreak: false });
  doc.text('(d)', COL.prev.x + 2, shY + 2, { lineBreak: false });
  doc.text('(e)', COL.curr.x + 2, shY + 2, { lineBreak: false });
  doc.text('(g/c)', COL.total.x, shY + 2, { lineBreak: false, width: COL.total.w, align: 'right' });
  doc.y = shY + 12;

  // Rows
  let alt = false;
  for (const item of sovItems) {
    const ry = doc.y;
    const sv = +item.scheduled_value || 0;
    const rowH2 = 15;

    if (alt) doc.rect(50, ry, 512, rowH2).fillColor('#f8f8f8').fill();
    alt = !alt;

    // vertical dividers
    doc.moveTo(COL.desc.x, ry).lineTo(COL.desc.x, ry + rowH2).strokeColor('#ddd').lineWidth(0.3).stroke();
    doc.moveTo(COL.sched.x, ry).lineTo(COL.sched.x, ry + rowH2).stroke();
    doc.moveTo(COL.prev.x, ry).lineTo(COL.prev.x, ry + rowH2).stroke();
    doc.moveTo(COL.curr.x, ry).lineTo(COL.curr.x, ry + rowH2).stroke();
    doc.moveTo(COL.total.x, ry).lineTo(COL.total.x, ry + rowH2).stroke();

    doc.font('Helvetica').fontSize(8.5).fillColor('#1a1a1a');
    doc.text(item.item_no || '', COL.num.x + 2, ry + 3, { lineBreak: false, width: COL.num.w - 4 });
    doc.text(item.description || '', COL.desc.x + 4, ry + 3, { lineBreak: false, width: COL.desc.w - 8 });

    doc.font('Helvetica').fontSize(8.5).fillColor('#1a1a1a');
    doc.text(fmt(sv), COL.sched.x + 2, ry + 3, { lineBreak: false, width: COL.sched.w - 4, align: 'right' });
    doc.text('—', COL.prev.x + 2, ry + 3, { lineBreak: false, width: COL.prev.w - 4, align: 'right' });
    doc.text('—', COL.curr.x + 2, ry + 3, { lineBreak: false, width: COL.curr.w - 4, align: 'right' });
    doc.text('0.00%', COL.total.x, ry + 3, { lineBreak: false, width: COL.total.w, align: 'right' });

    // row bottom border
    doc.moveTo(50, ry + rowH2).lineTo(562, ry + rowH2).strokeColor('#ddd').lineWidth(0.3).stroke();
    doc.y = ry + rowH2;
  }

  // Totals row
  const totY = doc.y + 2;
  doc.rect(50, totY, 512, 17).fillColor('#1a1a1a').fill();
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
  doc.text('TOTAL CONTRACT VALUE', COL.desc.x + 4, totY + 4, { lineBreak: false });
  doc.text(fmt(totalScheduled), COL.sched.x + 2, totY + 4, { lineBreak: false, width: COL.sched.w - 4, align: 'right' });
  doc.y = totY + 19;

  // Note
  doc.moveDown(1);
  doc.font('Helvetica').fontSize(8).fillColor('#777')
     .text('Note: "Prev. Comp." and "This Per." columns to be filled in at time of pay application. Retainage per contract terms.',
       50, doc.y, { width: 512 });

  // ---- Signature block ----
  doc.moveDown(2);
  const sigY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a1a').text('Contractor:', 50, sigY);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a1a').text('Owner / GC:', 320, sigY);

  const lineY = sigY + 32;
  doc.moveTo(50,  lineY).lineTo(280, lineY).strokeColor('#333').lineWidth(0.5).stroke();
  doc.moveTo(320, lineY).lineTo(562, lineY).strokeColor('#333').lineWidth(0.5).stroke();

  doc.font('Helvetica').fontSize(8).fillColor('#777');
  doc.text('Signature / Date', 50,  lineY + 4);
  doc.text('Signature / Date', 320, lineY + 4);

  doc.end();
}

function generateSovBuffer(bundle) {
  return new Promise((resolve, reject) => {
    const { estimate: e } = bundle;
    const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
      Title: 'Schedule of Values — ' + (e.project_name || e.id),
      Author: COMPANY.name
    }});
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    writeSovToDoc(doc, bundle);
  });
}

function generateSov(res, bundle) {
  const { estimate: e } = bundle;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
    Title: 'Schedule of Values — ' + (e.project_name || e.id),
    Author: COMPANY.name
  }});
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    'attachment; filename="SOV_' + (e.bid_number || e.id) + '.pdf"');
  doc.pipe(res);
  writeSovToDoc(doc, bundle);
}

module.exports = { generateSov, generateSovBuffer };
