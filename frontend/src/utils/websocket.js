let socket = null;
let droppedMalformedWsCount = 0;

function safeJsonParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function getSafeQnaData() {
  return safeJsonParse(sessionStorage.getItem("qnaData"), {});
}

function connectWebSocket(username, navigate) {
  if (socket) return;

  socket = new WebSocket(process.env.REACT_APP_BACKEND_URL);

  socket.onopen = () => {
    socket.send(JSON.stringify({ username }));
  };

  socket.onmessage = (event) => {
    const data = safeJsonParse(event.data, null);
    if (!data || typeof data !== "object") {
      droppedMalformedWsCount += 1;
      console.warn(`WebSocket - dropped malformed message. count=${droppedMalformedWsCount}`);
      return;
    }
    handleWebSocketCommand(data, navigate);
  };

  socket.onclose = () => {
    socket = null;
    setTimeout(() => connectWebSocket(username, navigate), 750);
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
  };
}

function handleWebSocketCommand(data, navigate) {
  const username = localStorage.getItem("username") || "amy";

  if (data.action === "navigation") {
    const option = data.option;
    if (!option) return;

    if ((option === "/general" || option === "/qna") && data.data != null) {
      sessionStorage.setItem("qnaData", JSON.stringify(data.data));
      navigate("/qna");
      window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
      return;
    }

    if (option === "/today-activity") {
      navigate(`/dashboard/${username}`);
      return;
    }

    navigate(option);
    return;
  }

  if (data.action === "status") {
    sessionStorage.setItem("visualStatus", JSON.stringify({ message: data.message, type: data.type, timestamp: Date.now() }));
    if (window.location.pathname.includes("/general/") || window.location.pathname === "/qna") {
      window.dispatchEvent(new CustomEvent("visualStatusUpdate", { detail: data }));
    }
    return;
  }

  if (data.action === "qnaStageSet") {
    const parsed = getSafeQnaData();
    const merged = data.data && typeof data.data === "object"
      ? data.data
      : {
          ...parsed,
          activeStageIndex: Number.isFinite(Number(data.stageIndex)) ? Number(data.stageIndex) : (parsed.activeStageIndex || 0),
        };

    sessionStorage.setItem("qnaData", JSON.stringify(merged));
    window.dispatchEvent(new CustomEvent("qnaStage", {
      detail: {
        stageIndex: data.stageIndex,
        cue: data.cue || "",
        speech: data.speech || "",
      },
    }));
    window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
    return;
  }

  if (data.action === "updateVisuals" && window.location.pathname === "/qna" && data.data != null) {
    sessionStorage.setItem("qnaData", JSON.stringify(data.data));
    window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
    return;
  }

  if (data.action === "qnaEnd") {
    window.dispatchEvent(new CustomEvent("qnaEnd", { detail: { reason: data.reason || "user_done" } }));
    setTimeout(() => {
      if (window.location.pathname === "/qna") {
        navigate(`/dashboard/${username}`);
      }
    }, 300);
    return;
  }

  if (data.action === "reminder" || data.action === "reminderDue" || data.action === "reminderSet" || data.action === "nudge") {
    sessionStorage.setItem("reminderData", JSON.stringify({ ...data, username }));
    const eventName = data.action === "nudge" ? "exerciseNudge"
      : data.action === "reminderSet" ? "reminderSet"
      : data.action === "reminderDue" ? "reminderDue"
      : "medicationReminder";
    window.dispatchEvent(new CustomEvent(eventName, { detail: { ...data, username } }));
  }
}

export { connectWebSocket };