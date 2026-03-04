import React, { useEffect, useMemo, useRef, useState } from "react";
import { FiMic, FiSend, FiUser, FiBarChart2 } from "react-icons/fi";
import CustomLineChart from "../components/CustomLineChart";
import CustomPie from "../components/CustomPie";
import Ring from "../components/Ring";
import SingleValue from "../components/SingleValue";
import CustomList from "../components/CustomList";
import { getCurrentTime } from "../utils/getCurrentTime";
import "../css/chartViewer.css";

const getBaseUrl = () => {
  const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  return isLocalDev ? "http://localhost:5001" : (process.env.REACT_APP_FETCH_DATA_URL || "http://localhost:5001");
};

const safeJsonParse = (value, fallback = null) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
};

const computeStats = (component) => {
  const d = component?.data;
  if (!d || typeof d !== "object") return null;
  const pts = Array.isArray(d.data) ? d.data
    : Array.isArray(d.points) ? d.points
    : Array.isArray(d.series?.points) ? d.series.points : [];
  if (!pts.length || typeof pts[0] !== "object") return null;
  const key = Object.keys(pts[0]).find((k) => typeof pts[0][k] === "number");
  if (!key) return null;
  const vals = pts.map((p) => Number(p[key])).filter(Number.isFinite);
  if (!vals.length) return null;
  return {
    avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
    high: Math.max(...vals),
    low: Math.min(...vals),
    unit: String(d?.yLabel || d?.unit || "").trim() || "",
  };
};

const renderComponent = (component) => {
  const name = component?.component || component?.type;
  if (!name) return null;
  switch (name) {
    case "CustomLineChart":
      return <CustomLineChart componentData={component} />;
    case "CustomPie":
      return <CustomPie componentData={component} />;
    case "Ring":
      return <Ring componentData={component} />;
    case "SingleValue":
      return <SingleValue componentData={component} />;
    case "CustomList":
      return <CustomList componentData={component} />;
    default:
      return null;
  }
};

const QnAPage = () => {
  const [time, setTime] = useState(getCurrentTime());
  const [activeComponent, setActiveComponent] = useState(null);
  const [chartTitle, setChartTitle] = useState("Your Health Data");
  const [explanation, setExplanation] = useState("");
  const [suggestion, setSuggestion] = useState(null);
  const [chat, setChat] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState(0);
  const [listening, setListening] = useState(false);
  const [voiceOk, setVoiceOk] = useState(false);

  const chatEndRef = useRef(null);
  const recRef = useRef(null);
  const malformedQnaParseCountRef = useRef(0);
  const loadingTimerRef = useRef(null);
  const loadingTimeoutRef = useRef(null);
  const enrichTimerRef = useRef(null);
  const chartReceivedForAskRef = useRef(false);

  const username = localStorage.getItem("username") || "amy";

  const stats = useMemo(() => computeStats(activeComponent), [activeComponent]);

  const clearLoadingTimers = () => {
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
    if (enrichTimerRef.current) clearTimeout(enrichTimerRef.current);
    loadingTimerRef.current = null;
    loadingTimeoutRef.current = null;
    enrichTimerRef.current = null;
  };

  useEffect(() => {
    const t = setInterval(() => setTime(getCurrentTime()), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setVoiceOk(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
  }, []);

  useEffect(() => () => clearLoadingTimers(), []);

  const applyQnaPayload = (parsed, stageIndexOverride = null, injectedSpeech = "") => {
    const stages = Array.isArray(parsed?.stages) ? parsed.stages : [];
    if (!stages.length) return;

    const rawIndex = Number.isFinite(stageIndexOverride) ? stageIndexOverride
      : (Number.isFinite(parsed?.activeStageIndex) ? parsed.activeStageIndex : 0);
    const idx = Math.min(Math.max(rawIndex, 0), stages.length - 1);
    const stage = stages[idx];
    const component = Array.isArray(stage?.components) ? stage.components[0] : null;

    chartReceivedForAskRef.current = true;

    if (component) {
      setActiveComponent(component);
      setChartTitle(component?.data?.title || stage?.cue || parsed?.question || "Your Health Data");
    }

    setChartLoading(false);
    setLoadingPhase(0);
    clearLoadingTimers();

    const exp =
      component?.explanationText ||
      component?.data?.insight ||
      stage?.speech ||
      parsed?.summary?.shortText ||
      parsed?.summary?.shortSpeech || "";

    if (exp) setExplanation(exp);

    const sug = Array.isArray(parsed?.suggestedQuestions)
      ? parsed.suggestedQuestions[0] || null : null;
    if (sug) setSuggestion(sug);

    const speechText = String(injectedSpeech || exp || "").trim();
    if (speechText) {
      setChat((prev) => {
        if (prev.length && prev[prev.length - 1].role === "assistant" && prev[prev.length - 1].text === speechText) {
          return prev;
        }
        return [...prev, { role: "assistant", text: speechText, suggestion: sug }];
      });
    }
  };

  const loadSession = () => {
    const raw = sessionStorage.getItem("qnaData");
    if (!raw) return;
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== "object") {
      malformedQnaParseCountRef.current += 1;
      console.warn(`QnA - Ignoring malformed session qnaData. count=${malformedQnaParseCountRef.current}`);
      return;
    }
    applyQnaPayload(parsed);
  };

  useEffect(() => {
    loadSession();
  }, []);

  useEffect(() => {
    const onUpdate = () => loadSession();
    const onStage = (e) => {
      const idx = Number(e.detail?.stageIndex);
      if (!Number.isFinite(idx)) return;
      const raw = sessionStorage.getItem("qnaData");
      if (!raw) return;
      const parsed = safeJsonParse(raw, null);
      if (!parsed || typeof parsed !== "object") return;
      const speech = String(e.detail?.speech || "").trim();
      applyQnaPayload(parsed, idx, speech);
    };

    window.addEventListener("qnaDataUpdated", onUpdate);
    window.addEventListener("qnaStage", onStage);
    return () => {
      window.removeEventListener("qnaDataUpdated", onUpdate);
      window.removeEventListener("qnaStage", onStage);
    };
  }, []);

  useEffect(() => {
    if (typeof chatEndRef.current?.scrollIntoView === "function") {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chat]);

  const ask = async (text) => {
    const q = String(text || "").trim();
    if (!q || busy) return;
    setBusy(true);
    setInput("");
    setChat((prev) => [...prev, { role: "user", text: q }]);

    chartReceivedForAskRef.current = false;

    setChartLoading(true);
    setLoadingPhase(1);
    loadingTimerRef.current = setTimeout(() => setLoadingPhase(2), 3000);
    enrichTimerRef.current = setTimeout(() => setLoadingPhase(3), 7000);

    loadingTimeoutRef.current = setTimeout(() => {
      setChartLoading(false);
      setLoadingPhase(0);
      clearLoadingTimers();
      if (!chartReceivedForAskRef.current) {
        setChat((prev) => [...prev, {
          role: "assistant",
          text: "It took too long to prepare your chart. Please try again.",
          suggestion: null,
        }]);
      }
      setBusy(false);
    }, 30000);

    fetch(`${getBaseUrl()}/api/alexa/browser-query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, question: q }),
    }).catch(() => {});

    try {
      const res = await fetch(`${getBaseUrl()}/api/alexa/qna-follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, question: q }),
      });
      const data = await res.json().catch(() => ({}));
      const answer = data?.answer || "";
      const sug = Array.isArray(data?.suggestions) ? data.suggestions[0] || null : null;
      if (answer) {
        setExplanation(answer);
        if (sug) setSuggestion(sug);
        setChat((prev) => [...prev, { role: "assistant", text: answer, suggestion: sug }]);
      }
    } catch (_) {}

    setBusy(false);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    ask(input);
  };

  const onVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || listening) return;
    const r = new SR();
    r.continuous = false;
    r.interimResults = false;
    r.lang = "en-US";
    recRef.current = r;
    r.onstart = () => setListening(true);
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    r.onresult = (ev) => {
      const t = ev.results?.[0]?.[0]?.transcript;
      if (t) {
        setInput(t);
        ask(t);
      }
    };
    r.start();
  };

  const latestSuggestion = (() => {
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i].suggestion) return chat[i].suggestion;
    }
    return suggestion || "How did I sleep this week?";
  })();

  return (
    <div className="hd-shell">
      <header className="hd-topbar">
        <span className="hd-time">{time}</span>
        <h1 className="hd-title">Health Assistant</h1>
        <span className="hd-user"><FiUser aria-hidden="true" /> Amy</span>
      </header>

      <main className="hd-main-grid">
        <section className="hd-left-column" aria-label="Chart and insight">
          <section className="hd-chart-panel" aria-label="Health chart">
            <div className="hd-chart-head">
              <FiBarChart2 className="hd-chart-icon" aria-hidden="true" />
              <h2>{chartTitle}</h2>
            </div>
            <div className="hd-chart-canvas">
              {chartLoading ? (
                <div className="hd-chart-loading">
                  <div className="hd-loading-bar"><div className="hd-loading-fill" /></div>
                  <p className="hd-loading-message">
                    {loadingPhase === 1 ? "Thinking..." :
                     loadingPhase === 2 ? "Fetching your Fitbit data..." :
                     "Building your chart..."}
                  </p>
                </div>
              ) : activeComponent ? (
                renderComponent(activeComponent)
              ) : (
                <p className="hd-chart-empty">Ask a question to see your chart here.</p>
              )}
            </div>
            {stats ? (
              <div className="hd-stats" aria-label="Summary stats">
                <span className="hd-stat">
                  Avg <strong>{stats.avg.toLocaleString()}</strong> {stats.unit}
                </span>
                <span className="hd-stat-sep" aria-hidden="true">|</span>
                <span className="hd-stat">
                  High <strong>{stats.high.toLocaleString()}</strong> {stats.unit}
                </span>
                <span className="hd-stat-sep" aria-hidden="true">|</span>
                <span className="hd-stat">
                  Low <strong>{stats.low.toLocaleString()}</strong> {stats.unit}
                </span>
              </div>
            ) : null}
          </section>

          {explanation ? (
            <section className="hd-explanation" aria-label="Explanation of the chart">
              <h3 className="hd-explanation-title">What this chart shows</h3>
              <p className="hd-explanation-body">{explanation}</p>
            </section>
          ) : null}
        </section>

        <aside className="hd-right-column" aria-label="AI chat panel">
          <section className="hd-chat-panel" aria-label="Chat">
            <div className="hd-chat-scroll">
              {chat.length === 0 ? (
                <p className="hd-chat-placeholder">
                  Ask any health question below. Your answer and chart will appear here.
                </p>
              ) : (
                chat.map((m, i) => (
                  <div key={i} className={`hd-bubble hd-bubble-${m.role}`}>
                    <p>{m.text}</p>
                  </div>
                ))
              )}
              {busy ? (
                <div className="hd-bubble hd-bubble-assistant hd-bubble-loading">
                  <p>Thinking...</p>
                </div>
              ) : null}
              <div ref={chatEndRef} aria-hidden="true" />
            </div>

            {latestSuggestion ? (
              <button
                type="button"
                className="hd-suggestion"
                onClick={() => ask(latestSuggestion)}
                disabled={busy}
                aria-label={`Suggested: ${latestSuggestion}`}
              >
                {latestSuggestion}
              </button>
            ) : null}

            <div className="hd-input-bar">
              <form className="hd-input-form" onSubmit={onSubmit}>
                <input
                  type="text"
                  className="hd-input"
                  placeholder="Ask a health question..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={busy}
                  aria-label="Type your question"
                />
                <button type="submit" className="hd-send-btn" disabled={busy || !input.trim()} aria-label="Send question">
                  <FiSend aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`hd-voice-btn ${listening ? "hd-voice-active" : ""}`}
                  onClick={onVoice}
                  disabled={!voiceOk || busy}
                  aria-label={listening ? "Listening..." : "Ask with voice"}
                  title={listening ? "Listening..." : "Ask with voice"}
                >
                  <FiMic aria-hidden="true" />
                </button>
              </form>
            </div>
          </section>
        </aside>
      </main>

      <footer className="hd-footer" role="contentinfo">Not medical advice.</footer>
    </div>
  );
};

export default QnAPage;
