import { NextRequest, NextResponse } from 'next/server';
import { getRegister } from '@/lib/server/governors/register';
import { writeGovernanceAuditOrThrow } from '@/lib/server/governance-audit';
import { canEditRegister } from '@/lib/server/governors/access';
import { authenticateGovernorRequest, governorErrorResponse } from '@/lib/server/governors/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function iso(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return ((value as { toDate: () => Date }).toDate()).toISOString();
  }
  return String(value);
}

/**
 * GET /api/admin/governors/export?format=csv|pdf (Phase 2, spec C.3).
 * Register readers may view, but exports - the portable copy - are a keeper
 * function restricted to the Founder and the NGS, and every export is
 * written to audit_logs. Server-generated from the register, never from
 * client state.
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateGovernorRequest(request, { edit: false });
  if ('error' in auth) return auth.error;
  if (!canEditRegister(auth.ctx.actor.uid, auth.ctx.actor.role)) {
    return NextResponse.json(
      { error: 'Forbidden: register exports are restricted to the Founder and the National General Secretary' },
      { status: 403 },
    );
  }
  const format = request.nextUrl.searchParams.get('format') === 'pdf' ? 'pdf' : 'csv';
  try {
    const register = await getRegister(auth.ctx.db, new Date());
    await writeGovernanceAuditOrThrow(auth.ctx.db, {
      action: 'governors_exported',
      actorUid: auth.ctx.actor.uid,
      actorRole: auth.ctx.actor.role ?? null,
      targetType: 'governors',
      targetId: 'register',
      details: { format },
    });
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'csv') {
      const header = [
        'seatKey', 'category', 'status', 'holderName', 'holderEmail',
        'termStart', 'termEnd', 'holderRoleKey', 'lastHolderName', 'version',
      ];
      const lines = [header.join(',')];
      for (const seat of register.seats) {
        lines.push(
          [
            seat.seatKey,
            seat.category,
            seat.effectiveStatus,
            seat.holderName ?? '',
            seat.holderEmail ?? '',
            iso(seat.termStart),
            iso(seat.termEnd),
            seat.holderRoleKey ?? '',
            seat.lastHolderName ?? '',
            seat.version,
          ]
            .map(csvEscape)
            .join(','),
        );
      }
      return new NextResponse(lines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="board-of-governors-${stamp}.csv"`,
        },
      });
    }

    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.setFontSize(16);
    doc.text('SEDS Pakistan - Board of Governors Register', 40, 50);
    doc.setFontSize(10);
    doc.text(
      `Exported ${new Date().toISOString()} - ${register.summary.seatedCount} of 9 seats filled - ${register.summary.quorum}`,
      40,
      68,
    );
    let y = 96;
    for (const seat of register.seats) {
      if (y > 780) {
        doc.addPage();
        y = 50;
      }
      doc.setFontSize(11);
      doc.text(`${seat.seatKey} - ${seat.category} - ${seat.effectiveStatus.toUpperCase()}`, 40, y);
      y += 14;
      doc.setFontSize(9);
      const detail =
        seat.effectiveStatus === 'seated'
          ? `${seat.holderName ?? ''} | term ${iso(seat.termStart)} to ${iso(seat.termEnd) || 'no fixed term'}`
          : `Vacant${seat.lastHolderName ? ` | last holder: ${seat.lastHolderName}` : ''}`;
      const wrapped = doc.splitTextToSize(detail, 500) as string[];
      doc.text(wrapped, 40, y);
      y += 12 * wrapped.length + 10;
    }
    const pdf = doc.output('arraybuffer');
    return new NextResponse(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="board-of-governors-${stamp}.pdf"`,
      },
    });
  } catch (err) {
    return governorErrorResponse(err);
  }
}
