const toAudioDataUrl = (audio) => {
  if (!audio || typeof audio !== "string") return null;
  if (audio.startsWith("data:audio")) return audio;
  return `data:audio/mpeg;base64,${audio}`;
};

export const stopNarration = (audioInstance) => {
  if (!audioInstance || typeof audioInstance.pause !== "function") return;
  try {
    audioInstance.pause();
    audioInstance.currentTime = 0;
  } catch (err) {
    console.warn("Failed to stop narration audio:", err);
  }
};

export const playNarration = (audio) => {
  if (typeof Audio === "undefined") return null;

  const src = toAudioDataUrl(audio);
  if (!src) return null;

  try {
    const audioInstance = new Audio(src);
    const playPromise = audioInstance.play();

    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((err) => {
        console.warn("Narration playback blocked or failed:", err);
      });
    }

    return audioInstance;
  } catch (err) {
    console.warn("Failed to initialize narration audio:", err);
    return null;
  }
};

export const fetchAndPlayChartNarration = async (text, baseUrl) => {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  const response = await fetch(`${baseUrl}/api/alexa/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: trimmed }),
  });

  if (!response.ok) {
    let errorMessage = `TTS request failed: ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.error) errorMessage = payload.error;
    } catch (_) {
      // Ignore non-JSON error body.
    }
    throw new Error(errorMessage);
  }

  const payload = await response.json();
  if (!payload?.audio) return null;

  return playNarration(payload.audio);
};
