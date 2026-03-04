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
  if (socket) {
    console.log("WebSocket is already connected.");
    return;
  }

  // create WebSocket connection
  socket = new WebSocket(process.env.REACT_APP_BACKEND_URL);

  socket.onopen = () => {
    console.log("WebSocket connection opened");
    // send username after connection
    socket.send(JSON.stringify({ username }));
  };

  socket.onmessage = (event) => {
    const data = safeJsonParse(event.data, null);
    if (!data || typeof data !== "object") {
      droppedMalformedWsCount += 1;
      console.warn(`WebSocket - Dropped malformed message. count=${droppedMalformedWsCount}`);
      return;
    }
    console.log("Message from server:", data);
    handleWebSocketCommand(data,navigate);
  };

  socket.onclose = () => {
    console.log("WebSocket connection closed. Reconnecting..");
    localStorage.clear();
    socket = null; // clear the socket
    setTimeout(() => connectWebSocket(username, navigate), 500); 
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
  };
}

function handleWebSocketCommand(data, navigate) {
    const username = localStorage.getItem("username") || "amy";
    console.log("WebSocket - Received command:", data);

    if (data.action === "navigation") {
      const option = data.option;
      if (option) {
        const targetRoute = option === "/general" || option === "/qna"
          ? "/qna"
          : option === "/today-activity"
            ? `/dashboard/${username}`
            : option;
        const dataPayload = data.data;

        if ((option === "/general" || option === "/qna") && dataPayload != null) {
          sessionStorage.setItem("qnaData", JSON.stringify(dataPayload));
          console.log("WebSocket - Stored qnaData in sessionStorage, navigating to /qna");
          navigate("/qna");
          // So QnAPage re-reads when already on /qna (e.g. full payload after loading)
          window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
        } else if (option === "/today-activity") {
          console.log("WebSocket - Navigating to dashboard for", username);
          navigate(`/dashboard/${username}`);
        } else if (targetRoute !== option) {
          navigate(targetRoute);
        } else {
          navigate(option);
        }
      }

      if (data.anchorKey) {
        console.log("WebSocket - Triggering anchor highlight for:", data.anchorKey);
        window.dispatchEvent(new CustomEvent("anchorHighlight", {
          detail: { anchorKey: data.anchorKey, duration: data.anchorDuration || 4000 },
        }));
      }
    } else if (data.action === "updateVisuals") {
      const currentKey = sessionStorage.getItem("currentVisualKey");
      if (currentKey) {
        const dataToStore = JSON.stringify(data.data);
        localStorage.setItem(currentKey, dataToStore);
        console.log("WebSocket - Updated visuals in place with key:", currentKey);
        window.dispatchEvent(new CustomEvent("visualsUpdated", { detail: { key: currentKey } }));
      }
      if (window.location.pathname === "/qna" && data.data != null) {
        const parsed = getSafeQnaData();
        if (data.data.enhancedVisuals && typeof data.data.enhancedVisuals === "object") {
          parsed.enhancedVisuals = data.data.enhancedVisuals;
        } else {
          const stages = Array.isArray(data.data.stages) ? data.data.stages : [];
          const deep = data.data.deepAnalysis;
          const deepComps = Array.isArray(deep?.components) ? deep.components : [];
          const stageComps = stages.flatMap((s) => (Array.isArray(s?.components) ? s.components : []));
          parsed.enhancedVisuals = {
            summary: data.data.summary?.shortText || deep?.interpretation || "Here are your detailed charts.",
            components: [...stageComps, ...deepComps],
          };
        }
        sessionStorage.setItem("qnaData", JSON.stringify(parsed));
        window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
        if (data.data.narrationAudio || data.data.narrationText) {
          window.dispatchEvent(new CustomEvent("narrationReady", {
            detail: {
              phase: "enhanced",
              audio: data.data.narrationAudio || null,
              text: data.data.narrationText || "",
            },
          }));
        }
      }
    } else if (data.action === "status") {
      console.log("WebSocket - Status message:", data.message, data.type);
      sessionStorage.setItem(
        "visualStatus",
        JSON.stringify({ message: data.message, type: data.type, timestamp: Date.now() })
      );
      if (window.location.pathname.includes("/general/") || window.location.pathname === "/qna") {
        window.dispatchEvent(new CustomEvent("visualStatusUpdate", { detail: data }));
      }
    } else if (data.action === "qnaStage") {
      console.log("WebSocket - QnA stage update:", data.stageIndex, data.cue);
      window.dispatchEvent(new CustomEvent("qnaStage", {
        detail: { stageIndex: data.stageIndex, cue: data.cue || "" },
      }));
    } else if (data.action === "qnaStageSet") {
      console.log("WebSocket - QnA stage set:", data.stageIndex, data.cue);
      const parsed = getSafeQnaData();
      if (data.data && typeof data.data === "object") {
        sessionStorage.setItem("qnaData", JSON.stringify(data.data));
      } else {
        const merged = {
          ...parsed,
          activeStageIndex: Number.isFinite(Number(data.stageIndex)) ? Number(data.stageIndex) : (parsed.activeStageIndex || 0),
        };
        sessionStorage.setItem("qnaData", JSON.stringify(merged));
      }
      window.dispatchEvent(new CustomEvent("qnaStage", {
        detail: {
          stageIndex: data.stageIndex,
          cue: data.cue || "",
          speech: data.speech || "",
        },
      }));
      window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
    } else if (data.action === "narrationAudio") {
      console.log("WebSocket - Narration audio received, phase:", data.phase);
      window.dispatchEvent(new CustomEvent("narrationReady", {
        detail: {
          phase: data.phase || "basic",
          audio: data.audio || null,
          text: data.text || "",
        },
      }));
    } else if (data.action === "qnaDeepReveal") {
      console.log("WebSocket - QnA deep reveal:", data);
      window.dispatchEvent(new CustomEvent("qnaDeepReveal", {
        detail: {
          deepAnalysis: data.deepAnalysis || null,
          cue: data.cue || "",
        },
      }));
    } else if (data.action === "qnaEnd") {
      console.log("WebSocket - QnA end:", data.reason);
      window.dispatchEvent(new CustomEvent("qnaEnd", {
        detail: { reason: data.reason || "user_done" },
      }));
      setTimeout(() => {
        if (window.location.pathname === "/qna") {
          navigate(`/dashboard/${username}`);
        }
      }, 300);
    } else if (data.action === "reminder") {
      console.log("WebSocket - Medication reminder:", data);
      sessionStorage.setItem("reminderData", JSON.stringify({ ...data, username }));
      window.dispatchEvent(new CustomEvent("medicationReminder", { detail: data }));
    } else if (data.action === "reminderDue") {
      console.log("WebSocket - Reminder due:", data);
      sessionStorage.setItem("reminderData", JSON.stringify({ ...data, username }));
      window.dispatchEvent(new CustomEvent("reminderDue", { detail: { ...data, username } }));
    } else if (data.action === "reminderSet") {
      console.log("WebSocket - Reminder set:", data);
      const parsed = getSafeQnaData();
      const merged = {
        ...parsed,
        summary: {
          shortText: data.summaryText || parsed?.summary?.shortText || "Reminder set.",
          shortSpeech: data.summaryText || parsed?.summary?.shortSpeech || "Reminder set.",
        },
        reminderSet: data,
      };
      sessionStorage.setItem("qnaData", JSON.stringify(merged));
      window.dispatchEvent(new CustomEvent("qnaDataUpdated"));
    } else if (data.action === "nudge") {
      console.log("WebSocket - Exercise nudge:", data);
      sessionStorage.setItem("reminderData", JSON.stringify({ ...data, username }));
      window.dispatchEvent(new CustomEvent("exerciseNudge", { detail: data }));
    } else if (data.action === "anchorHighlight") {
      // Handle anchor highlight on dashboard
      console.log("WebSocket - Anchor highlight:", data.anchorKey);
      window.dispatchEvent(new CustomEvent('anchorHighlight', { 
        detail: { anchorKey: data.anchorKey, duration: data.duration || 4000 } 
      }));
    } else {
      console.log("WebSocket - Unknown command received:", data.action);
    }
  }

// // send msg to backend
// function sendMessage(message) {
//   if (socket && socket.readyState === WebSocket.OPEN) {
//     socket.send(JSON.stringify(message));
//   } else {
//     console.error("WebSocket is not connected.");
//   }
// }

export { connectWebSocket };
