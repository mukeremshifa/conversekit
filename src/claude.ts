import Anthropic from '@anthropic-ai/sdk';

// ----------------------------------------------------------------
// Call Claude and return the full text response (non-streaming).
// Streaming can be added later by returning a ReadableStream instead.
// ----------------------------------------------------------------
export async function chat(
  apiKey: string,
  systemPrompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string
): Promise<string> {
  const client = new Anthropic({ apiKey });

  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  // Extract the text from the first content block
  const block = response.content[0];
  if (!block || block.type !== 'text') {
    throw new Error('Unexpected response shape from Claude API');
  }

  return block.text;
}
