import { NextRequest, NextResponse } from "next/server";
import { admin, getDb } from "@/lib/server/firebase-admin";
import { extractBearerToken as extractBearerHeader, verifyIdTokenString } from "@/lib/auth/verifySession";
import { resolveUserRole, hasServerPermission } from "@/lib/server/permissions";
import { executeWithFailover } from "@/lib/ai/key-manager";

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';


export async function POST(req: NextRequest) {
    try {
        // Admin AI route: must not be callable anonymously.
        const token = extractBearerHeader(req) ?? req.cookies.get('__session')?.value;
        if (!token) {
            return NextResponse.json({ error: "Sign in required" }, { status: 401 });
        }
        let decoded: admin.auth.DecodedIdToken;
        try {
            decoded = await verifyIdTokenString(token);
        } catch {
            return NextResponse.json({ error: "Invalid session" }, { status: 401 });
        }
        const role = await resolveUserRole(decoded.uid);
        if (!(await hasServerPermission(role, 'canManageSponsorsPartners'))) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const db = getDb();
        if (!db) {
            return NextResponse.json(
                { error: "Internal Server Error: Database not available" },
                { status: 500 }
            );
        }

        const { partnerId, agreementText, apiKey, model: userModel, context } = await req.json();

        if (!partnerId || !agreementText) {
            return NextResponse.json(
                { error: "Missing partnerId or agreementText" },
                { status: 400 }
            );
        }

        const intelligence = await executeWithFailover(async (genAI) => {
            const modelName = userModel || "gemini-1.5-flash";
            const model = genAI.getGenerativeModel({ model: modelName });
            const prompt = `
          Analyze the following partnership agreement text and extract key intelligence.
          
          ADDITIONAL CONTEXT (User provided history/notes):
          ${context || "None provided."}

          Return ONLY a valid JSON object with this structure:
          {
            "key_clauses": ["list of important clauses"],
            "deliverables_promised": ["what we must do"],
            "support_offered": ["what they will provide"],
            "risk_factors": ["potential risks or constraints"]
          }
          
          Agreement Text:
          ${agreementText.substring(0, 30000)} // Truncate to avoid massive context if needed, though 1.5 Flash handles 1M+
        `;

            const result = await model.generateContent(prompt);
            const responseText = result.response.text();

            // Clean up markdown code blocks if present
            const jsonString = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
            return JSON.parse(jsonString);
        }, apiKey);

        // 4. Save to Firestore
        await db.collection("sponsors_partners").doc(partnerId).update({
            agreementIntelligence: intelligence,
            updatedAt: new Date(), // Use server timestamp in real app, but Date is fine for now
        });

        return NextResponse.json({ success: true, intelligence });
    } catch (error: any) {
        console.error("Analysis error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to analyze agreement" },
            { status: 500 }
        );
    }
}
