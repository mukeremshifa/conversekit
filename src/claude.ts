import { GoogleGenerativeAI } from '@google/generative-ai';

// ----------------------------------------------------------------
// Call Gemini and return the full text response.
// Uses gemini-3.5-flash (1.5-flash no longer available on v2 API keys).
// The system prompt is passed as systemInstruction.
// History is converted from {role, content} to Gemini's {role, parts} shape.
// ----------------------------------------------------------------
export async function chat(
  apiKey: string,
  systemPrompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);

  const model = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    systemInstruction: systemPrompt,
  });

  // Gemini uses 'model' instead of 'assistant' for the AI role
  const geminiHistory = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const chatSession = model.startChat({ history: geminiHistory });
  const result = await chatSession.sendMessage(userMessage);
  const text = result.response.text();

  if (!text) throw new Error('Empty response from Gemini API');
  return text;
}


