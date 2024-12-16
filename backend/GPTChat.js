const { getCurrentDate } = require("../frontend/src/utils/getCurrentDate");

class GPTChat {
    constructor(apiKey, systemConfig = "You are a helpful assistant.") {
        this.apiKey = apiKey;
        this.history = []; // 保存历史会话
        this.systemConfig = systemConfig; // 系统配置
        // 初始化系统消息
        this.history.push({ role: "system", content: this.systemConfig });
        const today = getCurrentDate();
        this.history.push({ role: "user", content: "Today is " + today });
    }

    // 调用 GPT 接口
    async callGPT(userInput, model = "gpt-4o") {
        try {
            // 将用户输入添加到会话历史
            this.history.push({ role: "user", content: JSON.stringify(userInput) });

            // 调用 OpenAI API
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model: model,
                    messages: this.history, // 包含历史会话和系统配置
                }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error("Error calling OpenAI API:", errorData);
                throw new Error("Failed to call GPT API");
            }

            const responseData = await response.json();
            const assistantMessage = responseData.choices[0].message.content;

            // 将助手的回复添加到会话历史
            this.history.push({ role: "assistant", content: assistantMessage });

            return assistantMessage;
        } catch (error) {
            console.error("Error:", error.message);
            throw new Error("Failed to call GPT API");
        }
    }

    // 设置或更新系统配置
    setSystemConfig(newConfig) {
        this.systemConfig = newConfig;

        // 清空会话历史并重新初始化
        this.history = [{ role: "system", content: this.systemConfig }];
        const today = getCurrentDate();
        this.history.push({ role: "user", content: "Today is " + today });
    }

    // 清除会话历史
    clearHistory() {
        this.history = [{ role: "system", content: this.systemConfig }];
        const today = getCurrentDate();
        this.history.push({ role: "user", content: "Today is " + today });
    }

    // 获取当前的系统配置
    getSystemConfig() {
        return this.systemConfig;
    }
}

module.exports = GPTChat;
