let socket = null;
let droppedMalformedWsCount = 0;

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

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

  const normalizedUsername = normalizeUsername(username);
  const websocketUrl = process.env.REACT_APP_BACKEND_URL;
  console.log("[frontend websocket] connecting", {
    websocketUrl,
    username: normalizedUsername,
  });

  socket = new WebSocket(websocketUrl);

  socket.onopen = () => {
    console.log("[frontend websocket] connected", {
      websocketUrl,
      username: normalizedUsername,
    });
    socket.send(JSON.stringify({ username: normalizedUsername }));
    console.log("[frontend websocket] sent registration", {
      username: normalizedUsername,
    });
  };

  socket.onmessage = (event) => {
    const data = safeJsonParse(event.data, null);
    if (!data || typeof data !== "object") {
      droppedMalformedWsCount += 1;
      console.warn(`WebSocket - dropped malformed message. count=${droppedMalformedWsCount}`);
      return;
    }
    if (data.action === "navigation") {
      console.log("[frontend websocket] received navigation", {
        option: data.option,
        username: normalizedUsername,
        hasData: data.data != null,
      });
    }
    handleWebSocketCommand(data, navigate);
  };

  socket.onclose = () => {
    console.warn("[frontend websocket] closed", {
      username: normalizedUsername,
    });
    socket = null;
    setTimeout(() => connectWebSocket(normalizedUsername, navigate), 750);
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
  };
}

function handleWebSocketCommand(data, navigate) {
  const username = normalizeUsername(localStorage.getItem("username") || "amy");

  if (data.action === "displayAllStages") {
    const stages = Array.isArray(data.stages) ? data.stages : [];
    const firstStage = stages.find((stage) => stage && typeof stage === "object") || null;
    if (!firstStage) return;

    console.warn("[frontend websocket] deprecated displayAllStages received; falling back to stage 0 only");

    const payload = {
      ...firstStage,
      activeStageIndex: Number.isFinite(Number(firstStage.stageIndex)) ? Number(firstStage.stageIndex) : 0,
      stageCount: stages.length || 1,
      activePanelId: `stage_${Number.isFinite(Number(firstStage.stageIndex)) ? Number(firstStage.stageIndex) : 0}`,
      answer_ready: true,
      bundle_complete: stages.length <= 1,
      panels: firstStage.chart_spec ? [{
        panel_id: `stage_${Number.isFinite(Number(firstStage.stageIndex)) ? Number(firstStage.stageIndex) : 0}`,
        title: firstStage.title || "Health insight",
        subtitle: "",
        goal: "deep_dive",
        metrics: [],
        visual_family: firstStage.chart_spec.chart_type || "bar",
        chart_spec: firstStage.chart_spec,
      }] : undefined,
      spoken_answer: firstStage.voice_answer || firstStage.speech || firstStage.summary || "",
      voice_answer: firstStage.voice_answer || firstStage.speech || firstStage.summary || "",
      takeaway: firstStage.screen_text || firstStage.summary || firstStage.voice_answer || "",
      report_title: firstStage.title || "Health insight",
      primary_visual: firstStage.chart_spec || null,
      chart_spec: firstStage.chart_spec || null,
      summary: {
        shortSpeech: firstStage.voice_answer || firstStage.speech || "",
        shortText: firstStage.screen_text || firstStage.summary || "",
      },
      stages: stages.map((stage, index) => ({
        id: stage.id || `stage_${Number.isFinite(Number(stage?.stageIndex)) ? Number(stage.stageIndex) : index}`,
        speech: stage.speech || stage.voice_answer || "",
        voice_answer: stage.voice_answer || stage.speech || "",
        screen_text: stage.screen_text || stage.summary || "",
        chart_spec: stage.chart_spec || null,
        summary: stage.summary || "",
        title: stage.title || `Stage ${index + 1}`,
        stageIndex: Number.isFinite(Number(stage?.stageIndex)) ? Number(stage.stageIndex) : index,
      })),
    };

    sessionStorage.setItem("qnaData", JSON.stringify(payload));
    navigate("/qna");
    window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
    return;
  }

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
