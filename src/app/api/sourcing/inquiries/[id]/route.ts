import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { sendRawEmail } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

// PATCH: Update status, assigned engineer, quote amount, and engineering notes
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();

    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
    }

    const docRef = db.collection('sourcing_inquiries').doc(id);
    const existing = await docRef.get();

    if (!existing.exists) {
      return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 });
    }

    const updates: Record<string, any> = {
      ...body,
      updatedAt: new Date(),
    };

    await docRef.update(updates);

    return NextResponse.json({
      success: true,
      message: 'Inquiry updated successfully',
      data: updates,
    });
  } catch (error: any) {
    console.error('Error in PATCH /api/sourcing/inquiries/[id]:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to update inquiry' },
      { status: 500 }
    );
  }
}

// POST: Send formal DFM Feasibility & Quote Notification Email to applicant
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { customSubject, quoteAmount, leadTimeDays, dfmNotes, notifyApplicant } = body;

    ensureAdminInitialized();
    const db = getDb();
    if (!db) {
      return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
    }

    const docRef = db.collection('sourcing_inquiries').doc(id);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 });
    }

    const inquiry = docSnap.data() as any;

    // Update status to quote_ready
    await docRef.update({
      status: 'quote_ready',
      quoteAmount: quoteAmount || inquiry.quoteAmount || '',
      leadTimeDays: leadTimeDays || inquiry.leadTimeDays || '',
      dfmNotes: dfmNotes || inquiry.dfmNotes || '',
      quoteDeliveredAt: new Date(),
      updatedAt: new Date(),
    });

    // Send email if notifyApplicant is true
    if (notifyApplicant && inquiry.email) {
      const subject = customSubject || `[SEDS Sourcing Bridge] Official 48-Hour DFM & Benchmark Quote - ${inquiry.university}`;
      
      const emailResult = await sendRawEmail(
        inquiry.email,
        subject,
        `
          <div style="font-family: Arial, sans-serif; background-color: #0B0F19; color: #ffffff; padding: 30px; border-radius: 12px;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #60A5FA; margin: 0; font-size: 24px; letter-spacing: 1px;">SEDS SOURCING BRIDGE</h1>
              <p style="color: #9CA3AF; font-size: 13px; margin: 5px 0 0 0;">OFFICIAL DFM FEASIBILITY &amp; BENCHMARK QUOTE REPORT</p>
            </div>
            
            <div style="background-color: #111827; border: 1px solid #1F2937; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
              <h2 style="color: #34D399; font-size: 18px; margin-top: 0;">✓ DFM Review Complete &amp; Pricing Approved</h2>
              <p style="color: #E5E7EB; line-height: 1.6; font-size: 14px;">
                Hello <strong>${inquiry.fullName}</strong> (${inquiry.university}),<br><br>
                Our on-ground fellows at Shanghai Jiao Tong University (SJTU) have completed geometric validation and negotiated direct tier-1 factory pricing for your design package.
              </p>

              <table style="width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 13px; color: #D1D5DB;">
                <tr style="border-bottom: 1px solid #374151;">
                  <td style="padding: 8px 0; color: #9CA3AF;">Hardware Category:</td>
                  <td style="padding: 8px 0; font-weight: bold; color: #60A5FA;">${inquiry.category}</td>
                </tr>
                <tr style="border-bottom: 1px solid #374151;">
                  <td style="padding: 8px 0; color: #9CA3AF;">Quantity / Scope:</td>
                  <td style="padding: 8px 0;">${inquiry.quantity}</td>
                </tr>
                <tr style="border-bottom: 1px solid #374151;">
                  <td style="padding: 8px 0; color: #9CA3AF;">Benchmark Pricing:</td>
                  <td style="padding: 8px 0; font-weight: bold; color: #34D399; font-size: 15px;">${quoteAmount || 'Direct Factory Rate Confirmed'}</td>
                </tr>
                <tr style="border-bottom: 1px solid #374151;">
                  <td style="padding: 8px 0; color: #9CA3AF;">Estimated Spindle &amp; Air Lead Time:</td>
                  <td style="padding: 8px 0; font-weight: bold; color: #FBBF24;">${leadTimeDays || '10–14 Days'}</td>
                </tr>
              </table>

              ${dfmNotes ? `
              <div style="background-color: #1F2937; border-left: 4px solid #3B82F6; padding: 12px; margin-top: 15px; border-radius: 4px;">
                <strong style="color: #93C5FD; font-size: 13px;">Engineering Notes &amp; DFM Recommendations:</strong>
                <p style="color: #E5E7EB; font-size: 13px; margin: 6px 0 0 0; line-height: 1.5; white-space: pre-wrap;">${dfmNotes}</p>
              </div>` : ''}

              <div style="background-color: rgba(6, 182, 212, 0.1); border: 1px solid rgba(6, 182, 212, 0.3); border-radius: 6px; padding: 12px; font-size: 12px; color: #A5F3FC; margin-top: 15px;">
                🛡️ <strong>Quality Shield:</strong> All production batches include First-Article Inspection (FAI) with Zeiss CMM verification certificates prior to international express air dispatch.
              </div>
            </div>

            <div style="text-align: center; color: #9CA3AF; font-size: 12px; border-top: 1px solid #1F2937; padding-top: 15px;">
              To authorize machining or discuss toolpath optimizations, reply directly to this email.<br>
              <strong>SEDS Pakistan Sourcing Bridge | SJTU Liaison Base</strong>
            </div>
          </div>
        `,
        `Dear ${inquiry.fullName},\n\nOur Shanghai engineering team has completed the DFM feasibility review for your hardware package (${inquiry.category}).\n\nQuote Summary:\n- Target: ${inquiry.university}\n- Benchmark Pricing: ${quoteAmount || 'See Attached Details'}\n- Production & Express Lead Time: ${leadTimeDays || '10–14 Days'}\n\nDFM Feedback & Engineering Notes:\n${dfmNotes || 'Toolpaths and critical tolerances verified. Ready for spindle scheduling.'}\n\nPlease reply directly to this email to lock in spindle time or request fine-tuning adjustments.\n\nBest regards,\nSEDS Pakistan Sourcing Bridge Team\nShanghai Jiao Tong University Corridor`
      );

      if (!emailResult.success) {
        return NextResponse.json(
          { error: emailResult.error || 'Failed to dispatch email via mail carrier' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      message: 'DFM review & quote report dispatched to applicant successfully',
    });
  } catch (error: any) {
    console.error('Error in POST /api/sourcing/inquiries/[id]:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to dispatch quote notification' },
      { status: 500 }
    );
  }
}
