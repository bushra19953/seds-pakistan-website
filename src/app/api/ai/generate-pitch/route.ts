import { NextRequest, NextResponse } from "next/server";
import { executeWithFailover } from "@/lib/ai/key-manager";

export async function POST(req: NextRequest) {
    try {
        const { partner, eventName, eventNeeds, apiKey, model: userModel, tone } = await req.json();

        if (!partner || !eventName) {
            return NextResponse.json(
                { error: "Missing partner or event details" },
                { status: 400 }
            );
        }

        const output = await executeWithFailover(async (genAI) => {
            const modelName = userModel || "gemini-1.5-flash";
            const model = genAI.getGenerativeModel({ model: modelName });

            const isFollowUp = partner.interactionHistory && partner.interactionHistory.length > 0;
            const contextType = isFollowUp ? "Follow-up / Re-engagement" : "Initial Cold Outreach";

            const prompt = `
          You are a master negotiator and strategic communication expert, applying the "Breakthrough Negotiation" framework.
          
          TASK:
          Write a high-conversion sponsorship pitch email to the partner below.
          
          CONTEXT TYPE: ${contextType}
          (If "Follow-up", reference previous context from history. If "Initial", focus on their public goals.)

          THE PARTNER:
          Name: ${partner.organizationName}
          Contact: ${partner.primaryContact?.name || "Partner"} (${partner.primaryContact?.role || "N/A"})
          Website: ${partner.website || "N/A"}
          History: ${JSON.stringify(partner.interactionHistory || [])}
          Agreement Intelligence: ${JSON.stringify(partner.intelligence)}
          Strategic Context (User Notes): ${partner.strategicContext || "N/A"}
          
          THE EVENT:
          Name: ${eventName}
          Context: ${eventNeeds}
          
          STRATEGIC FRAMEWORK (Apply these principles strictly):
          1.  **Joint Problem-Solving Stance**: Adopt a tone that is "soft on the people, hard on the problem." Sit side-by-side. Use collaborative language ("We," "Together").
          2.  **Step to Their Side (Disarm & Validate)**: *Crucial First Step.* Do not start by selling. Start by **listening** (metaphorically). Preemptively acknowledge their likely constraints or concerns ("Take the words out of their mouth"). Validate their perspective.
          3.  **The "Yes... And" Pivot**: Never use the word "But". Replace it with "Yes... And". Acknowledge their reality, *then* add your new possibility.
          4.  **Reframe (Change the Game)**: Shift from positions ("We need $5k") to interests ("You need high-value engagement"). Treat their potential hesitation not as a rejection, but as a problem to solve together.
          5.  **Ask Questions (Don't Assert)**: Use "What if?" and "How?" questions to guide them. Invite them to shape the deal ("Building on your goal of X, what if we...?").
          6.  **Build a Golden Bridge (Make it Easy)**:
              *   **Controlled Choice**: Don't just give one option. Offer A, B, or C (e.g., "We could do the Standard tier, OR a Pilot program, OR a Performance-based model").
              *   **Face-Saving**: Give them a dignified reason to say yes (e.g., "Given the market shift..." or "To align with your new initiative...").
          7.  **Expand the Pie**:
              *   **Low-Cost/High-Benefit**: Offer things cheap to us but valuable to them (e.g., "We can also provide data access...").
              *   **If-Then Formulas**: Address skepticism with conditional terms ("If we hit X metric, then Y happens").
          
          TONE RULES:
          *   **NO DESPERATION**: Do not beg, do not over-explain, do not use "please" excessively.
          *   **EQUAL FOOTING**: Speak as a peer/partner, not a supplicant.
          *   **CONFIDENT**: Assume they are interested if the value alignment is right.
          *   **Professional & Collaborative**: Use "I"-statements. Match their sensory language.
          
          OUTPUT FORMAT:
          Return a JSON object:
          {
            "subject": "The email subject line (catchy, <50 chars, focuses on THEIR interest)",
            "body": "The full email body (use <br> for line breaks). Address the contact by name. Use 'Yes...And', 'What If?', and offer a 'Controlled Choice' (options).",
            "strategy_note": "Explain specifically how you applied 'Golden Bridge' (Options/Face-Saving) and 'Expand the Pie' in this pitch. PLAIN TEXT ONLY. NO HTML TAGS."
          }
        `;

            const result = await model.generateContent(prompt);
            const responseText = result.response.text();

            let jsonString = responseText.replace(/```json/g, "").replace(/```/g, "").trim();

            // Robust JSON extraction: Find the first '{' and the last '}'
            const firstBrace = jsonString.indexOf('{');
            const lastBrace = jsonString.lastIndexOf('}');

            if (firstBrace !== -1 && lastBrace !== -1) {
                jsonString = jsonString.substring(firstBrace, lastBrace + 1);
            }

            return JSON.parse(jsonString);
        }, apiKey);

        return NextResponse.json(output);

    } catch (error: any) {
        console.error("Pitch generation error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to generate pitch" },
            { status: 500 }
        );
    }
}
