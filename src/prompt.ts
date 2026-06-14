import type { Bot } from './types';

// ----------------------------------------------------------------
// Build the system prompt that Claude receives for every request.
// Sections are only included when the data exists on the bot row.
// ----------------------------------------------------------------
export function buildSystemPrompt(bot: Bot): string {
  const lines: string[] = [
    `You are a helpful AI assistant for ${bot.business_name}.`,
    `Your name is ${bot.name}.`,
    '',
    'Your primary job is to help website visitors with questions about this business.',
    'Be friendly, concise, and professional. Always answer in the same language the user writes in.',
    '',
    '## Business Information',
  ];

  if (bot.hours) lines.push(`- Hours: ${bot.hours}`);
  if (bot.location) lines.push(`- Location: ${bot.location}`);
  if (bot.contact) lines.push(`- Contact: ${bot.contact}`);
  if (bot.services) {
    lines.push('');
    lines.push('## Services Offered');
    lines.push(bot.services);
  }

  lines.push('');
  lines.push('## Rules');
  lines.push('- Never invent information that is not provided above.');
  lines.push('- If you do not know something, tell the user to call or email the business.');
  lines.push('- Do not discuss competitors.');
  lines.push('- Keep responses short — 1-3 sentences unless the user asks for detail.');

  if (bot.custom_instructions) {
    lines.push('');
    lines.push('## Additional Instructions');
    lines.push(bot.custom_instructions);
  }

  return lines.join('\n');
}
