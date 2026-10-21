/**
 * Signed election certificate (spec Sections 2.1, 6.5).
 *
 * Modelled on src/app/api/profile/[userId]/credential-pdf/route.ts
 * (inline jsPDF) and the hash discipline of src/lib/certificates/
 * hash.ts: the certificate signature is a SHA-256 over the certificate
 * payload keyed with the server salt (CERTIFICATE_SALT), failing closed
 * when the env var is missing.
 *
 * The certificate records: election title, seats, elected Governors
 * with tallies, tie-by-lot reference where one occurred, the Returning
 * Officer's name and signature line, declaration timestamp, and a
 * verification reference. Delivery is to the National General
 * Secretary, the Board, and the Founder within 24 hours of count end
 * (Sec 7.9); the deadline rides on the result record.
 */

import { createHash } from "crypto";
import { getCertificateSalt } from "@/lib/certificates/hash";

export interface ElectionCertificateData {
  electionId: string;
  electionTitle: string;
  seats: number;
  elected: Array<{ candidateUid: string; name: string; votes: number }>;
  tallies: Record<string, number>;
  candidateNames: Record<string, string>;
  tieLotId: string | null;
  returningOfficerName: string;
  returningOfficerUid: string;
  declaredAtMillis: number;
  verificationUrl: string;
}

/** Canonical payload that the signature binds. */
export function certificatePayload(data: ElectionCertificateData): string {
  const electedPart = [...data.elected]
    .sort((a, b) => (a.candidateUid < b.candidateUid ? -1 : 1))
    .map((e) => `${e.candidateUid}:${e.votes}`)
    .join(",");
  return [
    "seds-election-certificate-v1",
    data.electionId,
    data.electionTitle,
    String(data.seats),
    electedPart,
    data.tieLotId ?? "",
    data.returningOfficerUid,
    String(data.declaredAtMillis),
  ].join("|");
}

export function signCertificate(
  data: ElectionCertificateData,
  salt: string = getCertificateSalt(),
): string {
  return createHash("sha256")
    .update(`${certificatePayload(data)}:${salt}`)
    .digest("hex");
}

export function certificateSha256(pdfBytes: Uint8Array): string {
  return createHash("sha256").update(pdfBytes).digest("hex");
}

/**
 * Generate the certificate PDF bytes. Dynamic import of jspdf mirrors
 * the credential-pdf route so the library never enters a client bundle.
 */
export async function buildElectionCertificatePdf(
  data: ElectionCertificateData,
): Promise<{ pdfBytes: Uint8Array; signature: string; sha256: string }> {
  const signature = signCertificate(data);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 72;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("SEDS Pakistan", pageWidth / 2, y, { align: "center" });
  y += 28;
  doc.setFontSize(15);
  doc.text("Election Certificate", pageWidth / 2, y, { align: "center" });
  y += 36;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const line = (text: string, gap = 18) => {
    doc.text(text, 56, y);
    y += gap;
  };

  line(`Election: ${data.electionTitle}`);
  line(`Seats: ${data.seats} Member Governor seat(s), seat category member_elected`);
  line(
    `Declared: ${new Date(data.declaredAtMillis).toISOString()} by the Returning Officer`,
  );
  y += 8;
  doc.setFont("helvetica", "bold");
  line("Elected Governors");
  doc.setFont("helvetica", "normal");
  for (const e of data.elected) {
    line(`- ${e.name}: ${e.votes} votes`);
  }
  y += 8;
  doc.setFont("helvetica", "bold");
  line("Full tally");
  doc.setFont("helvetica", "normal");
  for (const [uid, votes] of Object.entries(data.tallies)) {
    line(`- ${data.candidateNames[uid] ?? uid}: ${votes}`);
  }
  if (data.tieLotId) {
    y += 8;
    line(`A tie at the seat cutoff was decided by lot. Record: ${data.tieLotId} (Sec 7.8).`);
  }
  y += 16;
  line(`Returning Officer: ${data.returningOfficerName}`);
  line("Signature: ______________________________");
  y += 8;
  line(`Verify: ${data.verificationUrl}`);
  line(`Certificate signature (SHA-256): ${signature}`);

  const bytes = new Uint8Array(doc.output("arraybuffer"));
  return { pdfBytes: bytes, signature, sha256: certificateSha256(bytes) };
}
