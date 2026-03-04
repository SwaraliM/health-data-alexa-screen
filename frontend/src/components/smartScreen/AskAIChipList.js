import React from "react";

const AskAIChipList = ({ questions = [], onSelect }) => {
  if (!Array.isArray(questions) || questions.length === 0) return null;

  return (
    <div className="ss-ai-chip-list" aria-label="Suggested AI questions">
      {questions.map((question) => (
        <button
          key={question}
          type="button"
          className="ss-ai-chip"
          onClick={() => onSelect(question)}
        >
          {question}
        </button>
      ))}
    </div>
  );
};

export default AskAIChipList;
