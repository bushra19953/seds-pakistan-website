import { NextRequest, NextResponse } from "next/server";
import { Principle } from "@/lib/principles";
import { executeWithFailover } from "@/lib/ai/key-manager";

export async function POST(req: NextRequest) {
    try {
        const { conversationText, situationContext, principles, apiKey, model: userModel } = await req.json();

        if (!conversationText && !situationContext) {
            return NextResponse.json(
                { error: "Missing conversation text or situation context" },
                { status: 400 }
            );
        }

        const output = await executeWithFailover(async (genAI) => {
            const modelName = userModel || "gemini-1.5-pro"; // Use Pro for complex reasoning
            const model = genAI.getGenerativeModel({ model: modelName });

            const activePrinciplesText = (principles as Principle[])
                .map((p, i) => `${i + 1}. "${p.title}" (${p.source}): ${p.content}`)
                .join("\n\n");

            const prompt = `
          You are the user's Strategic Advisor and Consigliere.
          Your goal is to help the user dominate interactions, gain power, and achieve their objectives by STRICTLY applying their Personal Principles.

          USER'S SACRED PRINCIPLES (The "Code"):
          ${activePrinciplesText || "No specific principles provided. Use general Machiavellian and Strategic best practices."}

          CURRENT SITUATION / CONVERSATION:
          ${conversationText}

          ADDITIONAL CONTEXT:
          ${situationContext || "N/A"}

          YOUR MISSION:
          1.  **Analyze**: Deeply analyze the situation through the lens of the User's Principles. 
              *   Identify where the other party is vulnerable.
              *   Identify if the user is violating any of their own laws.
              *   Map specific laws to the current dynamics.
          2.  **Strategize**: Formulate a plan that maximizes the user's gain and leverage using the principles.
          3.  **Execute**: Draft the perfect response and next steps.

          OUTPUT FORMAT (JSON ONLY):
          {
            "analysis": "2-3 sentences analyzing the power dynamics and psychological state, referencing specific Laws/Principles.",
            "suggested_reply": "Verbatim draft for email/text/speech. Tone should be calculated and effective.",
            "reply_rationale": "Why this specific wording was chosen, citing the Laws applied.",
            "next_actions": [
                { "text": "Concrete step 1", "rationale": "Link to Law X" },
                { "text": "Concrete step 2", "rationale": "Link to Law Y" }
            ],
            "risk_assessment": "Potential backfire risks and how to mitigate them."
          }
        `;

            const result = await model.generateContent(prompt);
            const responseText = result.response.text();

            let jsonString = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
            const firstBrace = jsonString.indexOf('{');
            const lastBrace = jsonString.lastIndexOf('}');

            if (firstBrace !== -1 && lastBrace !== -1) {
                jsonString = jsonString.substring(firstBrace, lastBrace + 1);
            }

            return JSON.parse(jsonString);
        }, apiKey);

        return NextResponse.json(output);

    } catch (error: any) {
        console.error("HQ Advisor error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to generate advice" },
            { status: 500 }
        );
    }
}
