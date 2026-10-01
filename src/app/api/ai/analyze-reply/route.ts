import { NextRequest, NextResponse } from "next/server";
import { executeWithFailover } from "@/lib/ai/key-manager";

export async function POST(req: NextRequest) {
    try {
        const { replyText, partnerName, history, strategicContext, apiKey, model: userModel } = await req.json();

        if (!replyText) {
            return NextResponse.json(
                { error: "Missing reply text" },
                { status: 400 }
            );
        }

        const output = await executeWithFailover(async (genAI) => {
            const modelName = userModel || "gemini-1.5-flash";
            const model = genAI.getGenerativeModel({ model: modelName });

            const prompt = `
          You are a master negotiator using the "Breakthrough Negotiation" framework (William Ury).
          
          CONTEXT:
          We are negotiating a sponsorship deal with ${partnerName || "a partner"}.
          Previous History: ${JSON.stringify(history || [])}
          STRATEGIC CONTEXT (User Notes): ${strategicContext || "N/A"}
          
          THEIR REPLY:
          "${replyText}"
          
          YOUR MISSION:
          1.  **Diagnose the Barrier**: Identify the specific barrier blocking agreement.
              *   *Reaction*: Are they acting out of anger, hostility, or rigidness?
              *   *Emotion*: Are they fearful, suspicious, or feeling unheard?
              *   *Position*: Are they digging in, stonewalling, or making rigid demands?
              *   *Dissatisfaction*: Is the offer not meeting their interests? Do they feel excluded?
              *   *Power*: Do they think they can win without us? Are they using power tactics?
              
          2.  **Select the Strategy**: Apply the SPECIFIC rule and sub-tactics to overcome that barrier.
              *   **Barrier: Reaction -> Go to the Balcony**
                  *   *Don't React*: Do not strike back, give in, or break off.
                  *   *Buy Time*: Pause and think.
                  *   *Keep Eyes on the Prize*: Focus on the goal, not the behavior.
              *   **Barrier: Emotion -> Step to Their Side**
                  *   *Listen*: Give them a hearing. Paraphrase to show understanding.
                  *   *Acknowledge*: Validate their feelings and competence.
                  *   *Agree*: Find common ground.
                  *   *Yes...And*: Use "Yes...And" instead of "But".
              *   **Barrier: Position -> Reframe**
                  *   *Ask Questions*: "Why?", "Why not?", "What if?".
                  *   *Reframe*: Turn their position into an interest. Reframe "You vs Me" to "Us vs Problem".
                  *   *Objective Standards*: Use fair standards/precedents to resolve differences.
              *   **Barrier: Dissatisfaction -> Build a Golden Bridge**
                  *   *Involve Them*: Ask for their ideas ("How would you solve this?").
                  *   *Satisfy Unmet Needs*: Address recognition, security, autonomy.
                  *   *Save Face*: Help them back down without looking weak.
                  *   *Go Slow to Go Fast*: Break it down into small steps.
              *   **Barrier: Power -> Use Power to Educate**
                  *   *Reality-Testing Questions*: "What do you think will happen if we don't agree?"
                  *   *Warn, Don't Threaten*: Predict consequences neutrally.
                  *   *Demonstrate BATNA*: Show you have alternatives without being aggressive.
                  *   *Third Force*: Bring in a neutral third party or coalition if needed.
              
          3.  **Draft the Response**: Write the email response applying the selected strategy strictly.
              *   The tone should be professional, calm, and strategic.
              *   Do NOT summarize the theory in the email. Just USE it.
          
          OUTPUT FORMAT (JSON):
          {
            "diagnosis": "One sentence explaining the barrier (e.g., 'They are stonewalling on price because...').",
            "strategy_applied": "Name of the principle used (e.g., 'Reframe Stone Walls as Aspirations').",
            "suggested_response": "The full email draft.",
            "coaching_tip": "A specific tip for the user on how to handle this psychologically (e.g., 'Do not answer their demand immediately...')."
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
        console.error("Negotiation analysis error:", error);
        return NextResponse.json(
            { error: error.message || "Failed to analyze reply" },
            { status: 500 }
        );
    }
}
