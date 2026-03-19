require("dotenv").config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TTS_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_VOICE = "coral";
const DEFAULT_INSTRUCTIONS = "Speak in a warm, clear, conversational health-advisor tone. Keep pace moderate for accessibility.";

/**
 * Generate speech from text using OpenAI TTS API.
 * @param {string} text - Text to convert to speech
 * @param {string} [voice="coral"] - Voice name (e.g. coral, alloy, nova)
 * @param {string} [instructions] - Optional instructions for tone/pace
 * @returns {Promise<string>} Base64-encoded MP3 audio
 */
async function generateSpeech(text, voice = DEFAULT_VOICE, instructions = DEFAULT_INSTRUCTIONS) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("generateSpeech: text is required");
  }

  const body = {
    model: "gpt-4o-mini-tts",
    voice: voice,
    input: trimmed,
  };
  if (instructions) {
    body.instructions = instructions;
  }

  const response = await fetch(TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("OpenAI TTS error:", response.status, errText);
    throw new Error(`TTS request failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString("base64");
}

module.exports = {
  generateSpeech,
};
