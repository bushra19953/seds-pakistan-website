'use server';
/**
 * @fileoverview A flow for the Research Copilot AI agent.
 */
import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const ResearchCopilotInputSchema = z.object({
  query: z.string().describe('The user\'s technical or scientific question.'),
});
export type ResearchCopilotInput = z.infer<typeof ResearchCopilotInputSchema>;

const ResearchCopilotOutputSchema = z.object({
  answer: z.string().describe('A detailed, expert-level answer to the user\'s query, formatted in Markdown.'),
  followUpQuestions: z.array(z.string()).describe('A list of 3-4 suggested follow-up questions to encourage further exploration.'),
});
export type ResearchCopilotOutput = z.infer<typeof ResearchCopilotOutputSchema>;

export async function generateCopilotResponse(input: ResearchCopilotInput): Promise<ResearchCopilotOutput> {
  return researchCopilotFlow(input);
}

const prompt = ai.definePrompt({
  name: 'researchCopilotPrompt',
  input: {schema: ResearchCopilotInputSchema},
  output: {schema: ResearchCopilotOutputSchema},
  prompt: `You are the SEDS Research Copilot, an expert AI assistant for students of space exploration and development. Your expertise covers aerospace engineering, astrophysics, computer science, robotics, and materials science.

A student has asked the following question:
"{{{query}}}"

Your task is to provide a comprehensive, accurate, and easy-to-understand answer.
- Format your answer in clear Markdown.
- If the query involves code, provide well-commented code snippets.
- If it involves complex concepts, use analogies or simpler examples.
- After the main answer, provide a few thoughtful follow-up questions the student could ask to deepen their understanding.
`,
});

const researchCopilotFlow = ai.defineFlow(
  {
    name: 'researchCopilotFlow',
    inputSchema: ResearchCopilotInputSchema,
    outputSchema: ResearchCopilotOutputSchema,
  },
  async (input) => {
    const {output} = await prompt(input);
    return output!;
  }
);
