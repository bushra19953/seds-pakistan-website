import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/server/firebase-admin";
import { executeWithFailover } from "@/lib/ai/key-manager";

export async function POST(req: NextRequest) {
    try {
        const db = getDb();
        if (!db) {
            console.error("Firebase Admin not initialized");
            return NextResponse.json(
                { error: "Internal Server Error: Database not available" },
                { status: 500 }
            );
        }

        const { eventName, eventNeeds, apiKey, model: userModel, status, partnerIds } = await req.json();

        if (!eventName || !eventNeeds) {
            return NextResponse.json(
                { error: "Missing eventName or eventNeeds" },
                { status: 400 }
            );
        }

        // 1. Fetch Partners
        let partners: any[] = [];

        if (partnerIds && Array.isArray(partnerIds) && partnerIds.length > 0) {
            // Batch mode: Fetch specific partners by ID
            const refs = partnerIds.map((id: string) => db.collection("sponsors_partners").doc(id));
            const snapshots = await db.getAll(...refs);

            partners = snapshots.map((doc) => {
                if (!doc.exists) return null;
                const data = doc.data() || {};
                return {
                    id: doc.id,
                    name: data.organizationName,
                    intelligence: data.agreementIntelligence,
                    primaryContact: data.primaryContact,
                    website: data.website,
                    interactionHistory: data.interactionHistory,
                    tier: data.sponsorshipTier,
                    strategicContext: data.strategicContext,
                };
            }).filter(Boolean); // Remove nulls
        } else {
            // Legacy/Fallback mode: Fetch all (filtered by status)
            let query: FirebaseFirestore.Query = db.collection("sponsors_partners");

            if (status && status !== "All") {
                query = query.where("status", "==", status);
            }

            const partnersSnapshot = await query.get();

            partners = partnersSnapshot.docs
                .map((doc) => {
                    const data = doc.data();
                    return {
                        id: doc.id,
                        name: data.organizationName,
                        intelligence: data.agreementIntelligence,
                        primaryContact: data.primaryContact,
                        website: data.website,
                        interactionHistory: data.interactionHistory,
                        tier: data.sponsorshipTier,
                        strategicContext: data.strategicContext,
                    };
                });
        }

        // Filter for valid data (must have intelligence or context)
        partners = partners.filter((p) => p.intelligence || p.strategicContext);

        if (partners.length === 0) {
            return NextResponse.json({
                matches: [],
                message: "No active partners with analyzed agreements found in this batch.",
            });
        }

        const matchesWithData = await executeWithFailover(async (genAI) => {
            // 2. Construct Prompt
            const partnersContext = partners
                .map(
                    (p) =>
                        `---
    PARTNER: ${p.name} (ID: ${p.id})
    WEBSITE: ${p.website || "N/A"}
    TIER: ${p.tier || "N/A"}
    PRIMARY CONTACT: ${p.primaryContact?.name || "N/A"} (${p.primaryContact?.role || "N/A"})
    INTERACTION HISTORY: ${JSON.stringify(p.interactionHistory || [])}
    AGREEMENT INTELLIGENCE: ${JSON.stringify(p.intelligence)}
    STRATEGIC CONTEXT: ${p.strategicContext || "N/A"}
    ---`
                )
                .join("\n");

            const modelName = userModel || "gemini-1.5-flash";
            const model = genAI.getGenerativeModel({ model: modelName });

            // Adjusted prompt for batching - we might not find 5 matches if the batch is small
            const prompt = `
          You are a strategic partnership analyst.

          OUR EVENT:
          Name: ${eventName}
          Needs/Goals: ${eventNeeds}

          OUR PARTNERS (Detailed Profiles):
          ${partnersContext}

          TASK:
          Analyze the partners and identify matches based on their agreement intelligence, past interactions, and tier.
          Since this is a subset of partners, list ALL that are good matches (score > 6). If none are good matches, return an empty list.
          Limit to at most 5 matches.

          Return a JSON object with this structure:
          {
            "matches": [
              {
                "id": "Partner ID",
                "organizationName": "Name",
                "score": 9, // 1-10 relevance
                "reason": "One clear sentence on why they are a match.",
                "key_factors": ["List 2-3 specific alignment points, e.g. 'Has budget for STEM', 'Contract mentions youth outreach'"]
              }
            ]
          }
        `;

            // 3. Generate Matches
            const result = await model.generateContent(prompt);
            const responseText = result.response.text();

            // Robust JSON extraction
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            const jsonString = jsonMatch ? jsonMatch[0] : responseText.replace(/```json/g, "").replace(/```/g, "").trim();

            const output = JSON.parse(jsonString);
            
            // Attach full partner data to matches so frontend can pass it to pitch generator
            return (output.matches || []).map((match: any) => {
                const originalPartner = partners.find(p => p.id === match.id);
                return {
                    ...match,
                    partnerData: originalPartner
                };
            });
        }, apiKey);

        return NextResponse.json({ matches: matchesWithData });
    } catch (error: any) {
        console.error("Matching error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to match partners" },
            { status: 500 }
        );
    }
}
