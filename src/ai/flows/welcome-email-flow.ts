'use server';
/**
 * @fileoverview A flow for generating a personalized welcome email.
 */
import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const WelcomeEmailInputSchema = z.object({
  name: z.string().describe('The name of the new member.'),
});
export type WelcomeEmailInput = z.infer<typeof WelcomeEmailInputSchema>;

const WelcomeEmailOutputSchema = z.object({
  subject: z.string().describe('The subject line of the welcome email.'),
  body: z.string().describe('The body of the welcome email, written in Markdown.'),
});
export type WelcomeEmailOutput = z.infer<typeof WelcomeEmailOutputSchema>;

export async function generateWelcomeEmail(input: WelcomeEmailInput): Promise<WelcomeEmailOutput> {
  return welcomeEmailFlow(input);
}

const prompt = ai.definePrompt({
  name: 'welcomeEmailPrompt',
  input: {schema: WelcomeEmailInputSchema},
  output: {schema: WelcomeEmailOutputSchema},
  prompt: `You are the official communications AI for SEDS Pakistan (Students for the Exploration and Development of Space).

Your task is to generate a personalized welcome email to a new member named {{{name}}}.

![SEDS Pakistan Logo](https://sedspakistan.live/assets/logo.png)

The email should be inspiring, futuristic, and welcoming. It should make the new member feel like they've just joined an exciting, forward-thinking community.

Here are the key points to include:
- A personalized greeting to {{{name}}}.
- Express excitement about them joining the mission.
- Briefly mention what SEDS Pakistan is about (e.g., forging the future of space exploration, community, projects).
- Mention that a separate email will follow with a "New Member's Guide" PDF (do not include a link).
- End with a futuristic and inspiring sign-off.

Generate a subject line and the email body. The body should be in Markdown format.
`,
});

const welcomeEmailFlow = ai.defineFlow(
  {
    name: 'welcomeEmailFlow',
    inputSchema: WelcomeEmailInputSchema,
    outputSchema: WelcomeEmailOutputSchema,
  },
  async (input) => {
    const {output} = await prompt(input);
    return output!;
  }
);
