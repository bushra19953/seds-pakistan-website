import { NextRequest, NextResponse } from 'next/server';
import { ensureAdminInitialized, getDb } from '@/lib/server/firebase-admin';
import { sendRawEmail } from '@/lib/mailer';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      fullName,
      university,
      email,
      phone,
      affiliation,
      category,
      material,
      quantity,
      deadline,
      tolerances,
      ndaAgreed,
      fileDownloadUrl,
      fileName,
      fileSizeBytes,
    } = body;

    // Basic Validation
    if (!fullName || !university || !email || !phone || !affiliation || !category || !quantity) {
      return NextResponse.json(
        { error: 'Missing required mandatory intake fields' },
        { status: 400 }
      );
    }

    if (!ndaAgreed) {
      return NextResponse.json(
        { error: 'Mutual NDA agreement must be acknowledged' },
        { status: 400 }
      );
    }

    // 1. Save directly to Firestore collection: 'sourcing_inquiries'
    ensureAdminInitialized();
    const db = getDb();
    let recordId = `INQ-${Date.now()}`;

    if (db) {
      const docRef = await db.collection('sourcing_inquiries').add({
        fullName,
        university,
        email,
        phone,
        affiliation,
        category,
        material: material || 'Aerospace Spec (Al 7075 / FR4 / Prepreg)',
        quantity,
        deadline: deadline || null,
        tolerances: tolerances || null,
        ndaAgreed: true,
        fileDownloadUrl: fileDownloadUrl || '',
        fileName: fileName || '',
        fileSizeBytes: fileSizeBytes || 0,
        status: 'pending_dfm_review', // pending_dfm_review | dfm_assigned | quote_ready | in_production | delivered
        assignedFellow: 'Unassigned',
        submittedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      recordId = docRef.id;
    }

    // 2. Prepare Webhook Payload for Discord / Slack / Telegram
    const webhookPayload = {
      event: 'sourcing_inquiry_received',
      inquiry_id: recordId,
      timestamp: new Date().toISOString(),
      applicant: {
        name: fullName,
        university: university,
        email: email,
        phone: phone,
        affiliation: affiliation,
      },
      specifications: {
        category: category,
        material: material || 'Al 7075-T651 Hard Anodized',
        quantity: quantity,
        file_download_url: fileDownloadUrl || '',
      },
    };

    // 3. Dispatch Webhook & Emails in parallel
    const notificationTasks = [
      // Webhook dispatch
      (async () => {
        const webhookUrl = process.env.SOURCING_WEBHOOK_URL || process.env.TELEGRAM_WEBHOOK_URL;
        if (webhookUrl) {
          try {
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(webhookPayload),
            });
          } catch (e) {
            console.warn('Webhook dispatch error:', e);
          }
        }
      })(),

      // Applicant confirmation email
      (async () => {
        try {
          await sendRawEmail(
            email,
            `[SEDS Sourcing Bridge] 48-Hour DFM Review Initiated - ${university}`,
            `
              <div style="font-family: Arial, sans-serif; background-color: #0B0F19; color: #ffffff; padding: 30px; border-radius: 12px;">
                <div style="text-align: center; margin-bottom: 24px;">
                  <h1 style="color: #60A5FA; margin: 0; font-size: 24px; letter-spacing: 1px;">SEDS SOURCING BRIDGE</h1>
                  <p style="color: #9CA3AF; font-size: 13px; margin: 5px 0 0 0;">ACADEMIC HARDWARE PIPELINE · SJTU FELLOW COORDINATED</p>
                </div>
                
                <div style="background-color: #111827; border: 1px solid #1F2937; border-radius: 8px; padding: 20px; margin-bottom: 20px;">
                  <h2 style="color: #34D399; font-size: 18px; margin-top: 0;">✓ Engineering Intake Package Received</h2>
                  <p style="color: #E5E7EB; line-height: 1.6; font-size: 14px;">
                    Hello <strong>${fullName}</strong>,<br><br>
                    Your design package for <strong>${university}</strong> has been transmitted to our on-ground engineering coordination base in Shanghai.
                  </p>

                  <table style="width: 100%; border-collapse: collapse; margin: 15px 0; font-size: 13px; color: #D1D5DB;">
                    <tr style="border-bottom: 1px solid #374151;">
                      <td style="padding: 8px 0; color: #9CA3AF;">Hardware Category:</td>
                      <td style="padding: 8px 0; font-weight: bold; color: #60A5FA;">${category}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #374151;">
                      <td style="padding: 8px 0; color: #9CA3AF;">Quantity:</td>
                      <td style="padding: 8px 0;">${quantity}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #374151;">
                      <td style="padding: 8px 0; color: #9CA3AF;">Material & Finish:</td>
                      <td style="padding: 8px 0;">${material || 'Standard Aerospace Specification'}</td>
                    </tr>
                    ${deadline ? `
                    <tr style="border-bottom: 1px solid #374151;">
                      <td style="padding: 8px 0; color: #9CA3AF;">Target Launch Date:</td>
                      <td style="padding: 8px 0;">${deadline}</td>
                    </tr>
                    ` : ''}
                    ${fileDownloadUrl ? `
                    <tr style="border-bottom: 1px solid #374151;">
                      <td style="padding: 8px 0; color: #9CA3AF;">CAD Repository Link:</td>
                      <td style="padding: 8px 0;"><a href="${fileDownloadUrl}" style="color: #38BDF8; text-decoration: underline;">View Attached CAD Package</a></td>
                    </tr>
                    ` : ''}
                  </table>

                  <div style="background-color: #1F2937; border-left: 4px solid #38BDF8; padding: 12px; margin-top: 15px; font-size: 13px; color: #9CA3AF;">
                    <strong>Next Steps:</strong> A Shanghai Jiao Tong University fellow is conducting toolpath feasibility analysis. You will receive an official benchmark quote and DFM report within 48 hours.
                  </div>
                </div>

                <div style="text-align: center; color: #9CA3AF; font-size: 12px; border-top: 1px solid #1F2937; padding-top: 15px;">
                  Expected DFM &amp; Benchmark Turnaround: <strong>48 Hours</strong><br>
                  Operational Base: Shanghai Jiao Tong University / Yangtze River Delta Precision Corridor
                </div>
              </div>
            `,
            `Hello ${fullName},\n\nWe have successfully received your engineering CAD package for ${university} (${category}). Our Shanghai Jiao Tong University (SJTU) engineering team is reviewing your toolpaths and tolerances.\n\nSummary:\n- Category: ${category}\n- Quantity: ${quantity}\n- Material: ${material || 'Aerospace Spec'}\n\nWe will deliver your comprehensive DFM report and benchmark quote within 48 hours.\n\nBest regards,\nSEDS Pakistan Sourcing Bridge Team`
          );
        } catch (applicantEmailErr) {
          console.warn('Applicant confirmation email failed:', applicantEmailErr);
        }
      })(),

      // Admin notification email
      (async () => {
        try {
          const adminEmail = process.env.SOURCING_ADMIN_EMAIL || process.env.ADMIN_NOTIFICATION_EMAIL || 'president@sedspakistan.org';
          await sendRawEmail(
            adminEmail,
            `🚀 [Sourcing Lead] ${fullName} (${university}) - ${category}`,
            `
              <div style="font-family: Arial, sans-serif; padding: 20px; background: #0B0F19; color: #fff;">
                <h2 style="color: #60A5FA;">🚀 New SEDS Sourcing Bridge Lead</h2>
                <p><strong>Name:</strong> ${fullName}</p>
                <p><strong>University / Lab:</strong> ${university}</p>
                <p><strong>Email:</strong> <a href="mailto:${email}" style="color: #38BDF8;">${email}</a></p>
                <p><strong>Phone / WhatsApp:</strong> <a href="tel:${phone}" style="color: #34D399;">${phone}</a></p>
                <p><strong>Affiliation:</strong> ${affiliation}</p>
                <p><strong>Category:</strong> ${category}</p>
                <p><strong>Quantity:</strong> ${quantity}</p>
                <p><strong>Material:</strong> ${material || 'Standard'}</p>
                <p><strong>Tolerances / Notes:</strong> ${tolerances || 'None provided'}</p>
                ${fileDownloadUrl ? `<p><strong>CAD Download Link:</strong> <a href="${fileDownloadUrl}" style="color: #FBBF24; word-break: break-all;">${fileDownloadUrl}</a></p>` : ''}
              </div>
            `,
            `New Sourcing Lead Received:\n\nName: ${fullName}\nUniversity: ${university}\nEmail: ${email}\nPhone: ${phone}\nChapter: ${affiliation}\nCategory: ${category}\nQuantity: ${quantity}\nMaterial: ${material || 'N/A'}\nFile Download: ${fileDownloadUrl || 'N/A'}\nTolerances: ${tolerances || 'N/A'}`
          );
        } catch (adminEmailErr) {
          console.warn('Admin notification email failed:', adminEmailErr);
        }
      })(),
    ];

    // Ensure all email and webhook dispatches complete before closing response
    await Promise.allSettled(notificationTasks);

    return NextResponse.json({
      success: true,
      message: 'Engineering intake inquiry received. 48-Hour DFM review initiated. Confirmation email dispatched.',
      data: webhookPayload,
    });
  } catch (error: any) {
    console.error('Error in /api/sourcing/submit:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to process inquiry' },
      { status: 500 }
    );
  }
}
