/**
 * 🚀 SEDS Pakistan - Premium Mission Workflow PDF Export (PRO MAX)
 * Operational Directive Design System with:
 * - Scannable QR Traceability
 * - Strategic Command Briefing Section
 * - Vector-drawn Professional Icons
 * - Hierarchical Personnel & Resource Matrix
 */

import { jsPDF } from 'jspdf';
import QRCode from 'qrcode';
import { canonicalRoleTitle } from './roles';

export interface WorkflowPDFFellowAssignee {
  id: string;
  name: string;
  role?: string | null;
  chapterName?: string | null;
  email?: string | null;
  whatsapp?: string | null;
  photoBase64?: string | null;
}

export interface WorkflowPDFStep {
  id?: string;
  title: string;
  description?: string;
  role?: string;
  assigneeName?: string;
  assigneeEmail?: string;
  assigneeWhatsapp?: string;
  assigneeChapter?: string;
  assigneeRole?: string | null;
  status?: string;
  individualDeadline?: string;
  sequenceIndex?: number;
  assigneeId?: string;
  assigneePhoto?: string;
  // All assignees on the step (primary doer first). Anyone beyond the first
  // renders as a full per-person row with their own QR, so co-assignees are
  // never silently dropped from the directive.
  assignees?: WorkflowPDFFellowAssignee[];
  points?: number;
  penaltyPoints?: number;
  workflowBonusPoints?: number;
  guidance?: string;
  stepInstructions?: string;
  complexity?: 1 | 2 | 3 | 4 | 5; // New
  domain?: string; // New: Avionics, Propulsion, etc.
  resources?: Array<{ title: string; url: string; type: string }>; // New
}

export interface WorkflowPDFData {
  id: string;
  title: string;
  progressPercentage: number;
  totalSteps: number;
  completedSteps: number;
  isCompleted: boolean;
  chapterName?: string; 
  createdAt?: string;
  description?: string; // Strategic Intent
  commanderStatement?: string; // High-level directive
  participants?: string[];
  steps: WorkflowPDFStep[];
  /** Optional appendix: full verbatim text rendered as appendix pages (with page breaks). */
  appendixTitle?: string;
  appendixText?: string;
}

const THEME = {
  paperWhite: [252, 252, 250] as [number, number, number],
  cardHeader: [241, 245, 249] as [number, number, number], 
  deepCharcoal: [15, 23, 42] as [number, number, number],   
  burntOrange: [180, 60, 20] as [number, number, number],   
  pakistanGreen: [1, 65, 28] as [number, number, number],
  goldAccent: [184, 134, 11] as [number, number, number],   
  grayBorder: [215, 220, 225] as [number, number, number],  
  grayLight: [248, 250, 252] as [number, number, number],   
  textMuted: [71, 85, 105] as [number, number, number],     
  shadow: [232, 233, 238] as [number, number, number],
  linkBlue: [0, 80, 160] as [number, number, number]
};

const getStatusColor = (status?: string): [number, number, number] => {
  const s = String(status || '').toLowerCase();
  if (s === 'completed' || s === 'approved') return THEME.pakistanGreen;
  if (s === 'overdue') return [190, 18, 60];
  if (s === 'in-progress') return [202, 138, 4];
  if (s === 'submitted-for-review') return [2, 132, 199];
  return [100, 116, 139];
};

const getStatusLabel = (status?: string): string => {
  const s = String(status || '').toLowerCase();
  if (s === 'submitted-for-review') return 'REVIEW';
  if (s === 'in-progress') return 'ACTIVE';
  return s.toUpperCase() || 'PENDING';
};

const URL_BREAK_CHARS = '/-_?&=';

/** Split one overlong token at / - _ ? & = (sep stays at chunk end), else hard chunk. */
const splitOverlongUrlSegment = (doc: jsPDF, segment: string, maxWidth: number): string[] => {
  const chunks: string[] = [];
  let current = '';
  const flush = () => { if (current) { chunks.push(current); current = ''; } };
  for (const ch of segment) {
    const trial = current + ch;
    if (doc.getTextWidth(trial) > maxWidth && current.length > 0) {
      let cut = -1;
      for (let i = current.length - 1; i >= 0; i--) {
        if (URL_BREAK_CHARS.includes(current[i])) { cut = i; break; }
      }
      if (cut >= 0) {
        chunks.push(current.slice(0, cut + 1));
        current = current.slice(cut + 1) + ch;
      } else {
        chunks.push(current);
        current = ch;
      }
    } else {
      current = trial;
    }
  }
  flush();
  return chunks;
};

/** Wrap a URL into lines that fit maxWidth. Sets the link font before measuring. */
const wrapUrlLines = (doc: jsPDF, url: string, maxWidth: number, fontSize: number): string[] => {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(fontSize);
  const lines: string[] = [];
  for (const segment of doc.splitTextToSize(url, maxWidth) as string[]) {
    if (doc.getTextWidth(segment) <= maxWidth) lines.push(segment);
    else lines.push(...splitOverlongUrlSegment(doc, segment, maxWidth));
  }
  return lines;
};

/**
 * Returns how many wrapped lines the URL needs at the given width and size.
 * Used for card height prediction before drawing. Returns 0 for empty URL.
 */
function measureUrlLines(
  doc: jsPDF,
  url: string,
  maxWidth: number,
  fontSize?: number
): number {
  if (!url) return 0;
  return wrapUrlLines(doc, url, maxWidth, fontSize ?? 7).length;
}

/**
 * Draws visible, clickable, underlined URL text. Returns vertical mm consumed.
 * Empty or missing URL draws nothing and returns 0.
 * Long URLs wrap within maxWidth, breaking at / - _ ? & = when needed.
 * Align left starts text at x; center centers on x; right ends text at x.
 */
function drawClickableUrl(
  doc: jsPDF,
  url: string,
  x: number,
  y: number,
  maxWidth: number,
  opts?: { fontSize?: number; align?: 'left' | 'center' | 'right' }
): number {
  const fontSize = opts?.fontSize ?? 7;
  const align = opts?.align ?? 'left';
  if (!url) return 0;
  const lines = wrapUrlLines(doc, url, maxWidth, fontSize);
  if (lines.length === 0) return 0;

  doc.setTextColor(...THEME.linkBlue);
  doc.setDrawColor(...THEME.linkBlue);
  doc.setLineWidth(0.15);

  const lineHeight = fontSize * 0.55;
  lines.forEach((line, i) => {
    const baseline = y + i * lineHeight;
    const w = doc.getTextWidth(line);
    let tx = x;
    if (align === 'center') tx = x - w / 2;
    else if (align === 'right') tx = x - w;
    doc.text(line, tx, baseline);
    doc.line(tx, baseline + 0.8, tx + w, baseline + 0.8);
    doc.link(tx, baseline - lineHeight + 0.3, w, lineHeight, { url });
  });

  return lines.length * lineHeight;
}

// MISSION ASSETS row label: the title when present, the URL itself when the
// title is blank so the row never renders as a bare number.
const assetRowLabel = (r: { title?: string | null; url?: string | null }, idx: number): string => {
  const text = (r.title && r.title.trim()) || r.url || '';
  return `${idx + 1}. ${text}`;
};

// ── Personnel rows (per-person layout) ─────────────────────────────────────
// Each person gets a full-width row: text on the left, ONE QR in a reserved
// right column. The QR column never grows leftward, so QRs can never draw
// on top of names/text however many assignees a step has.
const PERSONNEL_QR_SIZE = 22;
const PERSONNEL_QR_COL = 30; // 22 QR + 4 inset left + 4 inset right; URL wraps within this width
const PERSONNEL_QR_GAP = 4; // gap between the text column and the QR column
const PERSONNEL_ROW_PAD = 4; // 2 top + 2 bottom
const PERSONNEL_AVATAR_SIZE = 16;
const PERSONNEL_AVATAR_GAP = 4;
const PERSONNEL_CARD_PAD_X = 10;
const PERSONNEL_HEADER_H = 14; // labels line + deadline value line
const PERSONNEL_URL_FONT_SIZE = 6;
const PERSONNEL_URL_LINE_HEIGHT = PERSONNEL_URL_FONT_SIZE * 0.55;

interface PersonnelRowData {
  name: string;
  roleLabel?: string;
  responsibility?: string;
  chapter?: string;
  phone?: string;
  email?: string;
  photo?: string;
  id?: string;
  label: string;
  isPrimary: boolean;
}

interface PersonnelTextSegment {
  lines: string[];
  style: 'normal' | 'bold' | 'italic';
  size: number;
  lineHeight: number;
  color: [number, number, number];
  kind: 'name' | 'role' | 'responsibility' | 'chapter' | 'phone' | 'email';
  gapBefore: number;
}

/** Shrink the font from startSize down to minSize until text fits maxWidth. */
function fitFontSize(
  doc: jsPDF,
  text: string,
  startSize: number,
  minSize: number,
  maxWidth: number,
  style: 'normal' | 'bold' | 'italic'
): number {
  doc.setFont('helvetica', style);
  let size = startSize;
  doc.setFontSize(size);
  while (size > minSize && doc.getTextWidth(text) > maxWidth) {
    size -= 0.5;
    doc.setFontSize(size);
  }
  return size;
}

/** QR label for a fellow: the name they go by, skipping a leading Muhammad / Syed / Syeda / Mir when a second name exists, max 12 chars. */
const fellowQrLabel = (name: string): string => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const skipFirst = parts.length > 1 && /^(muhammad|syed|syeda|mir)$/i.test(parts[0]);
  const labelName = (skipFirst ? parts[1] : parts[0]) || 'TEAMMATE';
  return labelName.toUpperCase().slice(0, 12);
};

/**
 * Lay out one person's text block for a given text-column width. Returns the
 * segments to draw plus the exact block height. The drawing code uses these
 * same segments, line heights, and gaps, so measured height matches drawn
 * height exactly. Name and email stay on one line with shrink-to-fit (so a
 * long name or email is never split mid-token); role, responsibility, and
 * chapter wrap with splitTextToSize.
 */
function layoutPersonnelText(
  doc: jsPDF,
  row: PersonnelRowData,
  textWidth: number
): { segments: PersonnelTextSegment[]; height: number } {
  const w = Math.max(10, textWidth);
  const segments: PersonnelTextSegment[] = [];
  const nameSize = fitFontSize(doc, row.name, 11.5, 7, w, 'bold');
  segments.push({
    lines: [row.name],
    style: 'bold',
    size: nameSize,
    lineHeight: 5.5,
    color: THEME.deepCharcoal,
    kind: 'name',
    gapBefore: 0,
  });
  if (row.roleLabel) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    segments.push({
      lines: doc.splitTextToSize(row.roleLabel, w) as string[],
      style: 'bold',
      size: 9,
      lineHeight: 4.5,
      color: THEME.pakistanGreen,
      kind: 'role',
      gapBefore: 1,
    });
  }
  if (row.responsibility) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    segments.push({
      lines: doc.splitTextToSize(`Responsibility: ${row.responsibility}`, w) as string[],
      style: 'italic',
      size: 8,
      lineHeight: 4.5,
      color: THEME.textMuted,
      kind: 'responsibility',
      gapBefore: 1,
    });
  }
  if (row.chapter) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    segments.push({
      lines: doc.splitTextToSize(row.chapter, w) as string[],
      style: 'normal',
      size: 8.5,
      lineHeight: 4.5,
      color: THEME.textMuted,
      kind: 'chapter',
      gapBefore: 1,
    });
  }
  const contactWidth = Math.max(10, w - 6);
  if (row.phone) {
    const wa = row.phone.startsWith('+') ? row.phone : `+${row.phone}`;
    const phoneSize = fitFontSize(doc, wa, 9, 7, contactWidth, 'bold');
    segments.push({
      lines: [wa],
      style: 'bold',
      size: phoneSize,
      lineHeight: 5,
      color: THEME.pakistanGreen,
      kind: 'phone',
      gapBefore: 1.5,
    });
  }
  if (row.email) {
    const emailSize = fitFontSize(doc, row.email, 9, 6.5, contactWidth, 'bold');
    segments.push({
      lines: [row.email],
      style: 'bold',
      size: emailSize,
      lineHeight: 5,
      color: THEME.linkBlue,
      kind: 'email',
      gapBefore: row.phone ? 0.5 : 1.5,
    });
  }
  const height = segments.reduce((sum, s) => sum + s.gapBefore + s.lines.length * s.lineHeight, 0);
  return { segments, height };
};

const drawPhoneIcon = (doc: jsPDF, x: number, y: number, color: [number, number, number]) => {
    doc.saveGraphicsState();
    doc.setDrawColor(...color);
    doc.setLineWidth(0.3);
    doc.line(x, y + 2, x + 1, y);
    doc.line(x + 1, y, x + 2.5, y + 1.5);
    doc.line(x + 2.5, y + 1.5, x + 1.5, y + 2.5);
    doc.restoreGraphicsState();
};

const drawMailIcon = (doc: jsPDF, x: number, y: number, color: [number, number, number]) => {
    doc.saveGraphicsState();
    doc.setDrawColor(...color);
    doc.setLineWidth(0.25);
    doc.rect(x, y, 3.5, 2.5, 'S');
    doc.line(x, y, x + 1.75, y + 1.5);
    doc.line(x + 1.75, y + 1.5, x + 3.5, y);
    doc.restoreGraphicsState();
};

const drawCircularAvatar = (doc: jsPDF, imgB64: string, x: number, y: number, size: number) => {
  if (!imgB64) return;
  let saved = false;
  try {
    doc.saveGraphicsState();
    saved = true;
    const radius = size / 2;
    const centerX = x + radius;
    const centerY = y + radius;
    // Build the circle path without painting it, clip to it, then
    // terminate the clip with discardPath (n) inside the saved state,
    // so no pending clip survives the restore.
    doc.circle(centerX, centerY, radius, null);
    doc.clip();
    doc.discardPath();
    doc.addImage(imgB64, 'JPEG', x, y, size, size);
    doc.restoreGraphicsState();
    saved = false;
    doc.setDrawColor(...THEME.grayBorder);
    doc.setLineWidth(0.2);
    doc.circle(centerX, centerY, radius, 'S');
  } catch (e) {
    // Restore exactly once, and only if the saved state is still open.
    // Restoring again after a failure past the restore above would
    // unbalance the graphics state stack.
    if (saved) {
      try { doc.restoreGraphicsState(); } catch {}
    }
  }
};

export interface WorkflowPDFExportOptions {
  /** Skip all QR codes (cover + per-step). Use when the workflow has no live mission page. */
  hideQrCodes?: boolean;
  /** Skip the generic MISSION ASSET INVENTORY placeholder boxes on the briefing page. */
  hideAssetInventory?: boolean;
  /** 'task' draws "TASK ID" on the cover stat box; default 'workflow' draws "WORKFLOW ID". */
  documentKind?: 'task' | 'workflow';
}

export async function exportWorkflowAsPDF(workflow: WorkflowPDFData, logoB64?: string, options?: WorkflowPDFExportOptions) {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    putOnlyUsedFonts: true
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://sedspakistan.live';
  const workflowUrl = `${baseUrl}/missions/${workflow.id}`;

  const drawBackground = () => {
    doc.setFillColor(...THEME.paperWhite);
    doc.rect(0, 0, pageWidth, pageHeight, 'F');
  };

  // ── COVER PAGE ─────────────────────────────────────────────────────────────
  drawBackground();
  doc.setDrawColor(...THEME.deepCharcoal);
  doc.setLineWidth(0.2);
  doc.rect(8, 8, pageWidth - 16, pageHeight - 16); 
  doc.setLineWidth(1.5);
  doc.rect(12, 12, pageWidth - 24, pageHeight - 24); 

  let curY = 55;
  if (logoB64) {
    try {
      const imgProps = doc.getImageProperties(logoB64);
      const targetW = 90;
      doc.addImage(logoB64, 'PNG', (pageWidth - targetW) / 2, curY, targetW, targetW / (imgProps.width / imgProps.height));
      curY += (targetW / (imgProps.width / imgProps.height)) + 15;
    } catch (e) { curY += 25; }
  } else {
    doc.setTextColor(...THEME.deepCharcoal);
    doc.setFontSize(42); doc.setFont('helvetica', 'bold');
    doc.text('SEDS PAKISTAN', pageWidth / 2, curY, { align: 'center' });
    curY += 18;
  }

  doc.setTextColor(...THEME.burntOrange);
  doc.setFontSize(15); doc.setFont('times', 'italic');
  doc.text('A Flagship Space Exploration Initiative', pageWidth / 2, curY, { align: 'center' });
  curY += 12;

  if (workflow.chapterName) {
    doc.setTextColor(...THEME.pakistanGreen);
    doc.setFontSize(14); doc.setFont('helvetica', 'bold');
    doc.text(workflow.chapterName.toUpperCase(), pageWidth / 2, curY, { align: 'center' });
    curY += 18;
  } else { curY += 15; }

  doc.setTextColor(...THEME.deepCharcoal);
  doc.setFontSize(30); doc.setFont('helvetica', 'bold');
  const titleLines = doc.splitTextToSize(workflow.title.toUpperCase(), 160);
  doc.text(titleLines, pageWidth / 2, curY, { align: 'center' });
  curY += (titleLines.length * 11) + 25;

  const statW = (pageWidth - 40) / 4;
  let statX = 20;
  const drawStat = (label: string, value: string, color: [number, number, number]) => {
    doc.setFillColor(...color);
    doc.rect(statX, curY, statW - 3, 28, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    let valFontSize = 13;
    const maxW = statW - 9;
    doc.setFontSize(valFontSize);
    let displayValue = value;
    if (label.toLowerCase().includes('id') && value.length > 20) displayValue = value.substring(0, 15) + '...';
    while (doc.getTextWidth(displayValue) > maxW && valFontSize > 6) { valFontSize -= 0.5; doc.setFontSize(valFontSize); }
    doc.text(displayValue, statX + (statW - 3) / 2, curY + 11, { align: 'center' });
    doc.setFontSize(7);
    doc.text(label.toUpperCase(), statX + (statW - 3) / 2, curY + 21, { align: 'center' });
    statX += statW;
  };

  drawStat(options?.documentKind === 'task' ? 'Task ID' : 'Workflow ID', workflow.id.toUpperCase(), THEME.deepCharcoal);
  drawStat('Issue Date', new Date().toLocaleDateString(), THEME.deepCharcoal);
  drawStat('Steps', `${workflow.completedSteps} / ${workflow.totalSteps}`, THEME.deepCharcoal);
  drawStat('Progress', `${workflow.progressPercentage}%`, workflow.progressPercentage >= 100 ? THEME.pakistanGreen : [1, 45, 20]);
  curY += 28 + 15; // stat height (28) + padding (15) - QR goes below stats, not overlapping

  // PRO MAX: Cover QR Integration (skipped when hideQrCodes; e.g. task briefings with no live mission page)
  if (!options?.hideQrCodes) {
  try {
    const qrDataUrl = await QRCode.toDataURL(workflowUrl, { margin: 1, scale: 4 });
    const qrSize = 35;
    const qrX = (pageWidth - qrSize) / 2;
    const qrY = curY; // Position relative to content, not absolute from bottom
    doc.addImage(qrDataUrl, 'PNG', qrX, qrY, qrSize, qrSize);
    doc.setTextColor(...THEME.textMuted);
    doc.setFontSize(8);
    doc.text('SCAN TO VIEW LIVE MISSION STATUS', pageWidth / 2, qrY + qrSize + 4, { align: 'center' });
    // Clickable mission URL text below the cover QR label
    if (workflowUrl) {
      drawClickableUrl(doc, workflowUrl, pageWidth / 2, qrY + qrSize + 9, 150, { fontSize: 7.5, align: 'center' });
    }
    curY = qrY + qrSize + 18; // Update curY past QR + label + URL
  } catch (e) {
    console.error('QR Generate failed:', e);
  }
  }

  curY = Math.max(curY, pageHeight - 35); // Ensure directive box doesn't go off page
  doc.setFillColor(...THEME.burntOrange);
  doc.rect(20, curY, pageWidth - 40, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9); doc.setFont('helvetica', 'bold');
  doc.text('MISSION CONTROL DIRECTIVE:', 25, curY + 8);
  doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
  const directiveText = options?.hideQrCodes
    ? "This document is a static briefing. Personnel must utilize their interactive Unified Member Profile on the SEDS Platform to finalize assigned mission objectives."
    : "This document is a static briefing. Scannable QR codes link to real-time verification logs. Personnel must utilize their interactive Unified Member Profile on the SEDS Platform to finalize assigned mission objectives.";

  doc.text(doc.splitTextToSize(directiveText, pageWidth - 55), 25, curY + 13.5);

  // ── STRATEGIC BRIEFING PAGE ───────────────────────────────────────────────
  doc.addPage();
  drawBackground();
  
  doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(24); doc.setFont('helvetica', 'bold');
  doc.text('STRATEGIC COMMAND BRIEFING', 20, 25);
  doc.setDrawColor(...THEME.burntOrange); doc.setLineWidth(1); doc.line(20, 28, pageWidth - 20, 28);
  
  let briefY = 45;
  
  // Mission Intent
  doc.setTextColor(...THEME.burntOrange); doc.setFontSize(10); doc.text('OPERATIONAL INTENT', 20, briefY);
  doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(11.5); doc.setFont('helvetica', 'normal');
  const intentLines = doc.splitTextToSize(workflow.description || "The primary objective of this mission is to advance SEDS Pakistan's core objectives through coordinated technical execution and multi-disciplinary collaboration.", pageWidth - 40);
  doc.text(intentLines, 20, briefY + 8);
  briefY += (intentLines.length * 6) + 20;

  // Commander statement (Callout box)
  doc.setFillColor(248, 250, 255);
  doc.roundedRect(20, briefY, pageWidth - 40, 35, 2, 2, 'F');
  doc.setDrawColor(...THEME.linkBlue); doc.setLineWidth(1.5); doc.line(20, briefY, 20, briefY + 35);
  
  doc.setTextColor(...THEME.linkBlue); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text('COMMANDER\'S DIRECTIVE', 26, briefY + 8);
  doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(11); doc.setFont('times', 'italic');
  const statement = workflow.commanderStatement || "Precision in execution is the only pathway to success. Every assigned task is a critical component of the national initiative. Move fast, document evidence, and maintain 100% accountability.";
  doc.text(doc.splitTextToSize(statement, pageWidth - 60), 26, briefY + 16);
  briefY += 50;

  // Resource & Asset Matrix (placeholder boxes; skipped when hideAssetInventory)
  if (!options?.hideAssetInventory) {
  // Resource & Asset Matrix
  doc.setTextColor(...THEME.burntOrange); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
  doc.text('MISSION ASSET INVENTORY', 20, briefY);
  
  const matrixY = briefY + 5;
  const colW = (pageWidth - 40) / 3;
  
  const drawMatrixBox = (x: number, title: string, subtitle: string) => {
    doc.setFillColor(...THEME.cardHeader);
    doc.roundedRect(x, matrixY, colW - 4, 25, 2, 2, 'F');
    doc.setDrawColor(...THEME.grayBorder); doc.setLineWidth(0.1); doc.roundedRect(x, matrixY, colW - 4, 25, 2, 2, 'S');
    doc.setTextColor(...THEME.pakistanGreen); doc.setFontSize(8.5); doc.setFont('helvetica', 'bold');
    doc.text(title, x + (colW - 4) / 2, matrixY + 10, { align: 'center' });
    doc.setTextColor(...THEME.textMuted); doc.setFontSize(7); doc.setFont('helvetica', 'normal');
    doc.text(subtitle, x + (colW - 4) / 2, matrixY + 17, { align: 'center' });
  };

  drawMatrixBox(20, 'REPOSITORY', 'Code & Technical CAD');
  drawMatrixBox(20 + colW, 'DOCUMENTATION', 'Project Whitepapers');
  drawMatrixBox(20 + colW * 2, 'BRIEFINGS', 'Mission Recordings');
  }

  const margins = { top: 25, right: 20, bottom: 25, left: 20 };
  const contentWidth = pageWidth - margins.left - margins.right;

  // ── WORKFLOW STEPS ──────────────────────────────────────────────────────────
  curY = pageHeight; 
  
  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    const safeDesc = step.description || '';
    // Guidance may be a string or an object (e.g., {text: "..."}); extract text safely
    const rawGuidance = step.guidance as any;
    const safeGuidance = typeof rawGuidance === 'string'
      ? rawGuidance
      : (rawGuidance?.text || rawGuidance?.content || rawGuidance?.description || '');
    const safeInstructions = step.stepInstructions || '';

    const badgeWidth = 35;
    const titleAvailableWidth = contentWidth - 40 - badgeWidth; 
    
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15.5);
    const splitTitle = doc.splitTextToSize(step.title, titleAvailableWidth);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11.5);
    const splitDesc = safeDesc ? doc.splitTextToSize(safeDesc, contentWidth - 25) : [];
    doc.setFontSize(10.5);
    const splitGuidance = safeGuidance ? doc.splitTextToSize(safeGuidance, contentWidth - 45) : [];
    const splitInstructions = safeInstructions ? doc.splitTextToSize(safeInstructions, contentWidth - 50) : [];
    
    // ── Personnel rows: build BEFORE height prediction so the card height
    // sums the measured row heights instead of a fixed guess. ──
    const fellowAssignees = (step.assignees || []).filter(
      (a) => a && a.id !== step.assigneeId
    );
    const personnelRows: PersonnelRowData[] = [];
    const primaryNameValid = !!(step.assigneeName && !step.assigneeName.includes('@'));
    if (primaryNameValid) {
      const primaryRole = canonicalRoleTitle(step.assigneeRole);
      personnelRows.push({
        name: step.assigneeName as string,
        roleLabel: primaryRole && primaryRole !== 'Guest' ? primaryRole : undefined,
        responsibility: step.role || undefined,
        chapter: step.assigneeChapter || undefined,
        phone: step.assigneeWhatsapp || undefined,
        email: step.assigneeEmail || undefined,
        photo: step.assigneePhoto || undefined,
        id: step.assigneeId || undefined,
        label: 'SCAN TO SUBMIT',
        isPrimary: true,
      });
    } else {
      // No usable primary name: a Pending Assignment row (QR only when an
      // assigneeId is known), then one full row per fellow.
      personnelRows.push({
        name: 'Pending Assignment',
        id: step.assigneeId || undefined,
        label: 'SCAN TO SUBMIT',
        isPrimary: true,
      });
    }
    for (const a of fellowAssignees) {
      personnelRows.push({
        name: a.name,
        roleLabel: a.role ? canonicalRoleTitle(a.role) : undefined,
        chapter: a.chapterName || undefined,
        phone: a.whatsapp || undefined,
        email: a.email || undefined,
        photo: a.photoBase64 || undefined,
        id: a.id || undefined,
        label: fellowQrLabel(a.name),
        isPrimary: false,
      });
    }
    // Measure every row with the SAME layout function used to draw, so
    // prediction matches drawing exactly.
    const personnelRowInfos = personnelRows.map((row) => {
      const hasQr = !!(step.id && row.id && !options?.hideQrCodes);
      const avatarOffset = row.photo ? PERSONNEL_AVATAR_SIZE + PERSONNEL_AVATAR_GAP : 0;
      const textWidth = contentWidth - PERSONNEL_CARD_PAD_X * 2 - (hasQr ? PERSONNEL_QR_COL + PERSONNEL_QR_GAP : 0) - avatarOffset;
      const textLayout = layoutPersonnelText(doc, row, textWidth);
      const qrUrl = hasQr ? `${baseUrl}/profile/unified/${row.id}?task=${step.id}` : '';
      const qrUrlLines = hasQr ? measureUrlLines(doc, qrUrl, PERSONNEL_QR_COL, PERSONNEL_URL_FONT_SIZE) : 0;
      const qrContentH = hasQr ? PERSONNEL_QR_SIZE + 6.5 + qrUrlLines * PERSONNEL_URL_LINE_HEIGHT : 0;
      const avatarH = avatarOffset > 0 ? PERSONNEL_AVATAR_SIZE : 0;
      const rowHeight = Math.max(textLayout.height, qrContentH, avatarH) + PERSONNEL_ROW_PAD;
      return { row, hasQr, textWidth, textLayout, qrUrl, rowHeight };
    });
    const personnelRowsH = personnelRowInfos.reduce((sum, info) => sum + info.rowHeight, 0);
    // Divider gap + divider-to-header + header + rows + bottom padding.
    const personnelSectionH = 4 + 10 + PERSONNEL_HEADER_H + personnelRowsH + 6;
    const personnelNeeded = 10 + PERSONNEL_HEADER_H + personnelRowsH + 6;

    // Prediction including asset links
    let stepHeight = 35 + (splitTitle.length * 7); 
    if (step.points || step.penaltyPoints || step.workflowBonusPoints) stepHeight += 12;
    stepHeight += (splitDesc.length * 5.2) + 8;
    if (splitGuidance.length > 0) stepHeight += (splitGuidance.length * 5.2) + 12;
    if (splitInstructions.length > 0) stepHeight += (splitInstructions.length * 5.2) + 12;
    
    const hasAssets = (step.resources && step.resources.length > 0);
    stepHeight += personnelSectionH; // Personnel rows: measured sum (header + per-person rows + padding), never a fixed guess
    // Asset links render as a vertical stack (header + one wrapped line per link),
    // so predict their real height instead of a fixed 15.
    if (hasAssets) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
        const assetLinkWidth = contentWidth - 40;
        let assetLinkLines = 0;
        let assetUrlLines = 0;
        step.resources!.forEach((r, idx) => {
            assetLinkLines += doc.splitTextToSize(assetRowLabel(r, idx), assetLinkWidth).length;
            assetUrlLines += measureUrlLines(doc, r.url || '', assetLinkWidth, 7);
        });
        stepHeight += 12 + (assetLinkLines * 5) + (assetUrlLines * 4);
    }

    if (curY + stepHeight > pageHeight - margins.bottom - 10) {
      doc.addPage(); drawBackground();
      doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(22); doc.setFont('helvetica', 'bold');
      doc.text('MISSION EXECUTION PLAN', margins.left, margins.top);
      const lineY = margins.top + 8;
      doc.setDrawColor(...THEME.burntOrange); doc.setLineWidth(1.2); doc.line(margins.left, lineY, pageWidth - margins.right, lineY);
      doc.setLineWidth(4); doc.line(margins.left, lineY, margins.left + 55, lineY);
      curY = margins.top + 22;
    }

    const x = margins.left;
    const sColor = getStatusColor(step.status);
    const startY = curY;

    doc.setFillColor(...THEME.shadow);
    doc.roundedRect(x + 0.8, startY + 0.8, contentWidth, stepHeight - 12, 3, 3, 'F');
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(x, startY, contentWidth, stepHeight - 12, 3, 3, 'F');

    const headerH = 15 + (splitTitle.length * 6.5);
    doc.setFillColor(...THEME.cardHeader);
    doc.roundedRect(x, startY, contentWidth, headerH, 3, 3, 'F');
    doc.rect(x, startY + headerH - 3, contentWidth, 3, 'F');

    doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(28); doc.setFont('helvetica', 'bold');
    doc.text(String((step.sequenceIndex ?? i) + 1).padStart(2, '0'), x + 8, startY + 18);
    
    // Domain Badge
    if (step.domain) {
        doc.setFillColor(...THEME.pakistanGreen);
        doc.roundedRect(x + 7, startY + 22, 18, 4, 1, 1, 'F');
        doc.setTextColor(255, 255, 255); doc.setFontSize(5); doc.text(step.domain.toUpperCase(), x + 16, startY + 24.8, { align: 'center' });
    }

    doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(15); doc.setFont('helvetica', 'bold');
    doc.text(splitTitle, x + 25, startY + 14);
    
    doc.setFillColor(...sColor);
    doc.roundedRect(x + contentWidth - 30, startY + 4, 25, 7.5, 3.75, 3.75, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(7.5);
    doc.text(getStatusLabel(step.status), x + contentWidth - 17.5, startY + 9, { align: 'center' });

    let innerY = startY + headerH + 8;

    // Badges & Complexity (Only show if they exist/are meaningful)
    if ((step.points && step.points > 0) || step.complexity) {
      let badgeX = x + 25;
      if (step.points && step.points > 0) {
        doc.setFillColor(...THEME.pakistanGreen); doc.roundedRect(badgeX, innerY - 4.5, 30, 6.5, 3, 3, 'F');
        doc.setTextColor(255, 255, 255); doc.setFontSize(7); doc.text(`AWARD: ${step.points} PTS`, badgeX + 15, innerY - 0.2, { align: 'center' });
        badgeX += 33;
      }
      if (step.complexity) {
        doc.setTextColor(...THEME.burntOrange); doc.setFontSize(7); doc.setFont('helvetica', 'bold');
        doc.text('COMPLEXITY: ' + '★'.repeat(step.complexity), badgeX, innerY);
      }
      innerY += 12;
    }

    doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(11); doc.setFont('helvetica', 'normal');
    if (splitDesc.length > 0) { doc.text(splitDesc, x + 10, innerY); innerY += (splitDesc.length * 5.2) + 8; }

    if (splitGuidance.length > 0) {
      const gH = (splitGuidance.length * 5.2) + 6;
      doc.setFillColor(236, 252, 230); doc.rect(x + 10, innerY - 4, contentWidth - 20, gH, 'F');
      doc.setFillColor(...THEME.pakistanGreen); doc.rect(x + 10, innerY - 4, 1.5, gH, 'F');
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...THEME.pakistanGreen);
      doc.text('Guidance:', x + 15, innerY); doc.setFont('helvetica', 'normal'); doc.setTextColor(...THEME.deepCharcoal);
      doc.text(splitGuidance, x + 35, innerY); innerY += gH + 6;
    }

    // Asset Links - vertical numbered stack, one link per line, wrapped.
    // A horizontal row overflows the page when titles are long, so each
    // resource gets its own wrapped line with a page-break guard.
    if (hasAssets) {
        doc.setTextColor(...THEME.burntOrange); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
        doc.text('MISSION ASSETS:', x + 10, innerY);
        innerY += 6;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
        const assetLinkWidth = contentWidth - 40;
        step.resources?.forEach((r, idx) => {
            const label = assetRowLabel(r, idx);
            const splitLabel = doc.splitTextToSize(label, assetLinkWidth);
            const titleH = splitLabel.length * 4.6;
            const urlLines = measureUrlLines(doc, r.url || '', assetLinkWidth, 7);
            const urlBlockH = urlLines > 0 ? 1.5 + urlLines * 3.9 : 0;
            const blockH = titleH + urlBlockH;
            if (innerY + blockH > pageHeight - margins.bottom - 20) {
                doc.addPage(); drawBackground();
                innerY = margins.top + 10;
            }
            doc.setTextColor(...THEME.linkBlue);
            doc.text(splitLabel, x + 15, innerY);
            if (r.url) {
                doc.link(x + 15, innerY - 3.6, assetLinkWidth, blockH + 1, { url: r.url });
            }
            if (urlLines > 0) {
                // Visible clickable URL text under the title so links work in print
                drawClickableUrl(doc, r.url, x + 15, innerY + titleH + 1.5, assetLinkWidth, { fontSize: 7, align: 'left' });
            }
            innerY += blockH + 2.5;
        });
        innerY += 4;
    }

    // Personnel section: per-person rows. If the section will not fit on
    // this page, start a new page for it (steps with long descriptions can
    // exceed one page).
    let pY = innerY + 4;
    const personnelPageLimit = pageHeight - margins.bottom - 15;
    if (pY + personnelNeeded > personnelPageLimit) {
      doc.addPage(); drawBackground();
      doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(22); doc.setFont('helvetica', 'bold');
      doc.text('MISSION EXECUTION PLAN', margins.left, margins.top);
      const lineY2 = margins.top + 8;
      doc.setDrawColor(...THEME.burntOrange); doc.setLineWidth(1.2); doc.line(margins.left, lineY2, pageWidth - margins.right, lineY2);
      doc.setLineWidth(4); doc.line(margins.left, lineY2, margins.left + 55, lineY2);
      pY = margins.top + 22;
      // Fresh card background for the personnel section on the new page,
      // capped to the page so a many-assignee section does not draw a card
      // far past the page bottom (continuation pages get their own card).
      const personnelCardH = Math.min(personnelNeeded + 10, pageHeight - pY - margins.bottom);
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(x, pY - 8, contentWidth, personnelCardH, 3, 3, 'F');
    } else {
      doc.setDrawColor(...THEME.grayBorder); doc.setLineWidth(0.2); doc.line(x + 10, pY, x + contentWidth - 10, pY);
      pY += 10;
    }

    // Deadline value for the personnel header: right-aligned in the header
    // row above the person rows, never beside a QR.
    const dlStr = step.individualDeadline
      ? `T-MINUS: ${new Date(step.individualDeadline).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' })} ${new Date(step.individualDeadline).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: true })}`
      : 'TBD';

    // Draws the personnel header at headerY; rows start at headerY + HEADER_H.
    const drawPersonnelHeader = (headerY: number) => {
      doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(8.2); doc.setFont('helvetica', 'bold');
      doc.text('PERSONNEL ASSIGNED', x + 10, headerY);
      doc.text('MISSION DEADLINE', x + contentWidth - 10, headerY, { align: 'right' });
      doc.setFontSize(11.5);
      doc.text(dlStr, x + contentWidth - 10, headerY + 9, { align: 'right' });
    };

    let personnelHeaderY = pY;
    drawPersonnelHeader(personnelHeaderY);
    let rowTop = personnelHeaderY + PERSONNEL_HEADER_H;
    let personnelSpannedPages = false;

    // Draw one person's row at rowTop. Text lives in the left column; the
    // QR (when the person has one) lives in the reserved right column.
    const drawPersonRow = async (info: (typeof personnelRowInfos)[number]) => {
      const { row, hasQr, textLayout, qrUrl } = info;
      const rowLeft = x + PERSONNEL_CARD_PAD_X;
      const rowRight = x + contentWidth - PERSONNEL_CARD_PAD_X;
      const hasAvatar = !!row.photo;
      const textX = rowLeft + (hasAvatar ? PERSONNEL_AVATAR_SIZE + PERSONNEL_AVATAR_GAP : 0);
      // Text segments: the same layout measured for the height prediction.
      let textY = rowTop + PERSONNEL_ROW_PAD / 2;
      for (const seg of textLayout.segments) {
        textY += seg.gapBefore;
        doc.setFont('helvetica', seg.style);
        doc.setFontSize(seg.size);
        doc.setTextColor(...seg.color);
        for (const line of seg.lines) {
          textY += seg.lineHeight;
          const lineX = (seg.kind === 'phone' || seg.kind === 'email') ? textX + 6 : textX;
          if (seg.kind === 'phone') drawPhoneIcon(doc, textX, textY - 2.5, THEME.pakistanGreen);
          if (seg.kind === 'email') drawMailIcon(doc, textX, textY - 2.5, THEME.linkBlue);
          doc.text(line, lineX, textY);
          if (seg.kind === 'phone') {
            const wa = line.startsWith('+') ? line : `+${line}`;
            doc.link(textX, textY - 4, doc.getTextWidth(line) + 6, 5, { url: `https://wa.me/${wa.replace(/\+/g, '').replace(/[\s-]/g, '')}` });
          }
          if (seg.kind === 'email') {
            doc.link(textX, textY - 4, doc.getTextWidth(line) + 6, 5, { url: `mailto:${line}` });
          }
        }
      }
      // QR in the reserved right column: fixed x, never growing leftward.
      if (hasQr) {
        const qrX = rowRight - PERSONNEL_QR_COL + 4;
        const qrY = rowTop + PERSONNEL_ROW_PAD / 2;
        try {
          const qrDataUrl = await QRCode.toDataURL(qrUrl, { margin: 1, scale: 3 });
          doc.addImage(qrDataUrl, 'PNG', qrX, qrY, PERSONNEL_QR_SIZE, PERSONNEL_QR_SIZE);
        } catch (e) {
          console.error('Step QR generate failed:', e);
        }
        doc.setTextColor(...THEME.textMuted);
        doc.setFontSize(6.5);
        doc.text(row.label, qrX + PERSONNEL_QR_SIZE / 2, qrY + PERSONNEL_QR_SIZE + 3, { align: 'center' });
        // Clickable profile URL centered under the QR, wrapped within the
        // QR column so it can never bleed into the text column.
        drawClickableUrl(doc, qrUrl, qrX + PERSONNEL_QR_SIZE / 2, qrY + PERSONNEL_QR_SIZE + 6.5, PERSONNEL_QR_COL, { fontSize: PERSONNEL_URL_FONT_SIZE, align: 'center' });
      }
      // Avatar LAST (after all text). A bare W with no live path leaks a
      // clip that hides later rows; the clip in drawCircularAvatar is now
      // properly terminated with discardPath, so no pending clip survives.
      if (hasAvatar) {
        drawCircularAvatar(doc, row.photo ?? '', rowLeft, rowTop + PERSONNEL_ROW_PAD / 2, PERSONNEL_AVATAR_SIZE);
      }
    };

    for (let r = 0; r < personnelRowInfos.length; r++) {
      const info = personnelRowInfos[r];
      // Page-break: never split a person's row. If it does not fit in the
      // remaining space, start a fresh page with the plan header and a
      // fresh card background before drawing that row.
      if (rowTop + info.rowHeight > pageHeight - margins.bottom - 10) {
        personnelSpannedPages = true;
        doc.addPage(); drawBackground();
        doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(22); doc.setFont('helvetica', 'bold');
        doc.text('MISSION EXECUTION PLAN', margins.left, margins.top);
        const lineY3 = margins.top + 8;
        doc.setDrawColor(...THEME.burntOrange); doc.setLineWidth(1.2); doc.line(margins.left, lineY3, pageWidth - margins.right, lineY3);
        doc.setLineWidth(4); doc.line(margins.left, lineY3, margins.left + 55, lineY3);
        const contTop = margins.top + 22;
        const remainingH = 10 + PERSONNEL_HEADER_H + personnelRowInfos.slice(r).reduce((sum, inf) => sum + inf.rowHeight, 0) + 6;
        const contCardH = Math.min(remainingH + 10, pageHeight - contTop - margins.bottom);
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(x, contTop - 8, contentWidth, contCardH, 3, 3, 'F');
        personnelHeaderY = contTop + 10;
        drawPersonnelHeader(personnelHeaderY);
        rowTop = personnelHeaderY + PERSONNEL_HEADER_H;
      }
      await drawPersonRow(info);
      rowTop += info.rowHeight;
    }

    // curY tracks actual content end. When personnel spanned pages the
    // original startY-based estimate is stale, so use the last row end.
    curY = personnelSpannedPages ? rowTop + 12 : Math.max(startY + stepHeight + 15, rowTop + 6);

  }

  // Appendix: full verbatim task directive (optional), with page-break handling
  if (workflow.appendixText) {
    doc.addPage();
    drawBackground();
    doc.setTextColor(...THEME.deepCharcoal); doc.setFontSize(22); doc.setFont('helvetica', 'bold');
    doc.text(workflow.appendixTitle || 'APPENDIX: COMPLETE TASK DIRECTIVE', 20, 25);
    doc.setDrawColor(...THEME.burntOrange); doc.setLineWidth(1); doc.line(20, 28, pageWidth - 20, 28);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...THEME.deepCharcoal);
    const appLines = doc.splitTextToSize(workflow.appendixText, pageWidth - 40);
    let aY = 40;
    for (const ln of appLines) {
      if (aY > pageHeight - 25) {
        doc.addPage(); drawBackground(); aY = 25;
      }
      doc.text(ln, 20, aY);
      aY += 5;
    }
  }

  // Footer Global
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setFillColor(...THEME.pakistanGreen); doc.rect(0, pageHeight - 10, pageWidth / 2, 10, 'F');
    doc.setFillColor(...THEME.deepCharcoal); doc.rect(pageWidth / 2, pageHeight - 10, pageWidth / 2, 10, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(8.5); doc.setFont('helvetica', 'bold');
    const footerText = workflow.chapterName ? `SEDS PAKISTAN • MISSION: ${workflow.chapterName.toUpperCase()}` : 'SEDS PAKISTAN • NATIONAL INITIATIVE';
    doc.text(footerText, 10, pageHeight - 4);
    doc.setTextColor(...THEME.goldAccent); doc.text(`PAGE ${String(p).padStart(2, '0')} // ${String(totalPages).padStart(2, '0')}`, pageWidth - 10, pageHeight - 4, { align: 'right' });
  }

  doc.save(`SEDS_Directive_${workflow.title.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.pdf`);
}
