'use server';
/**
 * @fileoverview A flow for generating a study guide for a given topic.
 */
import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const StudyGuideInputSchema = z.object({
  topic: z.string().describe('The space-related topic to generate a study guide for.'),
});
export type StudyGuideInput = z.infer<typeof StudyGuideInputSchema>;

const KeyConceptSchema = z.object({
  concept: z.string().describe('The key concept or term.'),
  definition: z.string().describe('A concise definition of the concept.'),
});

const QuizQuestionSchema = z.object({
  question: z.string().describe('The multiple-choice question.'),
  options: z.array(z.string()).describe('An array of 4 possible answers.'),
  answer: z.string().describe('The correct answer.'),
});

const StudyGuideOutputSchema = z.object({
  summary: z.string().describe('A concise, easy-to-understand summary of the topic.'),
  keyConcepts: z
    .array(KeyConceptSchema)
    .describe('A list of 3-5 key concepts or terms with their definitions, like flashcards.'),
  quiz: z.array(QuizQuestionSchema).describe('A multiple-choice quiz with 3 questions to test understanding.'),
});
export type StudyGuideOutput = z.infer<typeof StudyGuideOutputSchema>;

export async function generateStudyGuide(input: StudyGuideInput): Promise<StudyGuideOutput> {
  return studyGuideFlow(input);
}

const prompt = ai.definePrompt({
  name: 'studyGuidePrompt',
  input: {schema: StudyGuideInputSchema},
  output: {schema: StudyGuideOutputSchema},
  prompt: `You are an AI Study Assistant for SEDS (Students for the Exploration and Development of Space).

Your task is to generate a helpful study guide for the following space-related topic: {{{topic}}}.

The study guide must contain three distinct sections:
1.  **Summary**: A concise, easy-to-understand summary of the topic (2-3 paragraphs).
2.  **Key Concepts**: A list of 3 to 5 important terms or concepts related to the topic. Each concept should have a brief definition, like a flashcard.
3.  **Quiz**: A short, 3-question multiple-choice quiz to test the user's knowledge. Each question must have 4 options and a clearly identified correct answer.

Please provide the output in the structured format requested.
`,
});

const studyGuideFlow = ai.defineFlow(
  {
    name: 'studyGuideFlow',
    inputSchema: StudyGuideInputSchema,
    outputSchema: StudyGuideOutputSchema,
  },
  async (input) => {
    const {output} = await prompt(input);
    return output!;
  }
);
