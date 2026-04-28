require('dotenv').config();
const { Anthropic } = require('@anthropic-ai/sdk');

async function test() {
  try {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL
    });

    console.log('Client created');

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Hello' }]
    });

    console.log('Response:', response.content[0].text.substring(0, 50));
  } catch (e) {
    console.log('Error:', e.message);
  }
}

test();
