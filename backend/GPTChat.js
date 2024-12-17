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
    async callGPT(userInput, model = "gpt-4o") {
        try {
            // add user input to the history
            this.history.push({ role: "user", content: JSON.stringify(userInput) });

            // call OpenAI API
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model: model,
                    messages: this.history, // contains history and system config
                }),
            });

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
    }

    // get current system config
    getSystemConfig() {
        return this.systemConfig;
    }
}

module.exports = GPTChat;
