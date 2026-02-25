const { getCurrentDate } = require("../frontend/src/utils/getCurrentDate");

class GPTChat {
    constructor(apiKey, systemConfig = "You are a helpful assistant.") {
        this.apiKey = apiKey;
        this.history = []; // save history
        this.systemConfig = systemConfig; // system config
        // initiate system config
        this.history.push({ role: "system", content: this.systemConfig });
        const today = getCurrentDate();
        this.history.push({ role: "user", content: "Today is " + today });
    }

    // call GPT api
    async callGPT(userInput, model = "gpt-5.2-codex", maxTokens = 300) {
        try {
            // add user input to the history
            this.history.push({ role: "user", content: JSON.stringify(userInput) });

            // call OpenAI API with timeout
            // Increased timeout for enhanced visuals (which can take longer)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout for GPT API

            try {
                // Build request body
                // If maxTokens is null/undefined, set to very high value (16000) to allow maximum context usage
                // GPT-4o has 128k context window, so 16k tokens for response is well within limits
                const requestBody = {
                    model: model,
                    messages: this.history, // contains history and system config
                    temperature: 0.7, // Slightly lower for more consistent, concise responses
                    max_completion_tokens: maxTokens !== null && maxTokens !== undefined ? maxTokens : 16000, // Very high limit to allow full context usage
                };
                
                const response = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    signal: controller.signal,
                    body: JSON.stringify(requestBody),
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errorData = await response.json();
                    console.error("Error calling OpenAI API:", errorData);
                    throw new Error("Failed to call GPT API");
                }

                const responseData = await response.json();
                const assistantMessage = responseData.choices[0].message.content;

                // add response of assistant to the history
                this.history.push({ role: "assistant", content: assistantMessage });

                return assistantMessage;
            } catch (fetchError) {
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    throw new Error("Request timeout - response took too long");
                }
                throw fetchError;
            }
        } catch (error) {
            console.error("Error:", error.message);
            throw new Error("Failed to call GPT API");
        }
    }

    // set system config
    setSystemConfig(newConfig) {
        this.systemConfig = newConfig;

        // clear history and re-initialization
        this.history = [{ role: "system", content: this.systemConfig }];
        const today = getCurrentDate();
        this.history.push({ role: "user", content: "Today is " + today });
    }

    // clear history
    clearHistory() {
        this.history = [{ role: "system", content: this.systemConfig }];
        const today = getCurrentDate();
        this.history.push({ role: "user", content: "Today is " + today });
        console.log("History is cleared.");
        console.log("Current history:", this.history);
    }

    // get current system config
    getSystemConfig() {
        return this.systemConfig;
    }
}

module.exports = GPTChat;
