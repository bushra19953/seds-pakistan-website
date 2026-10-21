/**
 * Intake window templates (Workstream E, spec 4.4).
 *
 * GET  /api/admin/intake-windows/templates  list templates
 * POST /api/admin/intake-windows/templates  create a template
 *
 * A template is only a recurring SHAPE. Creating one creates no window
 * and changes no surface. Templates are always created INACTIVE:
 * activation (and the durationDays value for the annual drive) waits
 * for Decision 17, and the Phase 2 compliance engine is the only
 * writer of recurrence windows (hand-off contract, spec 4.4).
 */

import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/server/firebase-admin';
import { writeIntakeAudit } from '@/lib/server/intake-windows';
import {
  INTAKE_TIMEZONE,
  VALID_INTAKE_KINDS,
  requireIntakeAdmin,
  validationError,
} from '../shared';

export const dynamic = 'force-dynamic';

const TEMPLATES_COLLECTION = 'intake_window_templates';

function serializeTemplate(id: string, data: Record<string, unknown>) {
  return {
    templateId: id,
    kind: typeof data.kind === 'string' ? data.kind : null,
    labelTemplate:
      typeof data.labelTemplate === 'string' ? data.labelTemplate : null,
    opensMonthDay:
      typeof data.opensMonthDay === 'string' ? data.opensMonthDay : null,
    durationDays:
      typeof data.durationDays === 'number' ? data.durationDays : null,
    timezone: typeof data.timezone === 'string' ? data.timezone : null,
    fyLabelMode:
      typeof data.fyLabelMode === 'string' ? data.fyLabelMode : null,
    active: data.active === true,
    createdBy: typeof data.createdBy === 'string' ? data.createdBy : null,
  };
}

export async function GET(request: NextRequest) {
  const gate = await requireIntakeAdmin(request);
  if (!gate.ok) return gate.response;
  try {
    const snap = await gate.db.collection(TEMPLATES_COLLECTION).get();
    return NextResponse.json({
      templates: snap.docs.map((d) =>
        serializeTemplate(d.id, d.data() as Record<string, unknown>),
      ),
    });
  } catch (err) {
    console.error('[intake-windows] templates list failed:', err);
    return NextResponse.json({ error: 'list_failed' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireIntakeAdmin(request);
  if (!gate.ok) return gate.response;
  const { db, uid } = gate;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const kind = body.kind as string;
  if (!VALID_INTAKE_KINDS.includes(kind as never)) {
    return validationError('kind', 'Unknown intake window kind.');
  }
  const labelTemplate =
    typeof body.labelTemplate === 'string' ? body.labelTemplate.trim() : '';
  if (labelTemplate.length < 3 || labelTemplate.length > 120) {
    return validationError('labelTemplate', 'labelTemplate is required (3 to 120 chars).');
  }
  const opensMonthDay =
    typeof body.opensMonthDay === 'string' ? body.opensMonthDay : '';
  const mdMatch = /^(\d{2})-(\d{2})$/.exec(opensMonthDay);
  if (
    !mdMatch ||
    Number(mdMatch[1]) < 1 ||
    Number(mdMatch[1]) > 12 ||
    Number(mdMatch[2]) < 1 ||
    Number(mdMatch[2]) > 31
  ) {
    return validationError('opensMonthDay', "opensMonthDay must be 'MM-DD'.");
  }
  const durationDays = body.durationDays;
  if (
    typeof durationDays !== 'number' ||
    !Number.isInteger(durationDays) ||
    durationDays < 1 ||
    durationDays > 120
  ) {
    return validationError('durationDays', 'durationDays must be an integer from 1 to 120.');
  }
  if (body.timezone !== undefined && body.timezone !== INTAKE_TIMEZONE) {
    return validationError('timezone', `Only ${INTAKE_TIMEZONE} is supported.`);
  }
  if (body.fyLabelMode !== undefined && body.fyLabelMode !== 'opens-year') {
    return validationError('fyLabelMode', "Only 'opens-year' is supported.");
  }

  let templateId: string;
  if (typeof body.templateId === 'string' && body.templateId.trim()) {
    templateId = body.templateId.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(templateId)) {
      return validationError('templateId', 'templateId must be a slug.');
    }
  } else {
    const slug = labelTemplate
      .replace(/\{[^}]*\}/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '');
    templateId = `${kind}-${slug || 'template'}`;
  }

  try {
    const ref = db.collection(TEMPLATES_COLLECTION).doc(templateId);
    const existing = await ref.get();
    if (existing.exists) {
      return NextResponse.json(
        { error: 'template_id_conflict', templateId },
        { status: 409 },
      );
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    const data: Record<string, unknown> = {
      templateId,
      kind,
      labelTemplate,
      opensMonthDay,
      durationDays,
      timezone: INTAKE_TIMEZONE,
      fyLabelMode: 'opens-year',
      // Always inactive at creation: activation waits for Decision 17.
      active: false,
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
    };
    const batch = db.batch();
    batch.set(ref, data);
    await writeIntakeAudit(
      db,
      {
        action: 'intake_template_created',
        actorUid: uid,
        targetUidOrResource: templateId,
        payload: { kind, opensMonthDay, durationDays, active: false },
      },
      batch,
    );
    await batch.commit();
    return NextResponse.json(
      { template: serializeTemplate(templateId, data) },
      { status: 201 },
    );
  } catch (err) {
    console.error('[intake-windows] template create failed:', err);
    return NextResponse.json({ error: 'create_failed' }, { status: 500 });
  }
}
