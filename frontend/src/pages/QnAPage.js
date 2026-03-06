import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiMic, FiSend, FiUser, FiBarChart2, FiType } from "react-icons/fi";
import EChartCard from "../components/EChartCard";
import { getCurrentTime } from "../utils/getCurrentTime";
import { validateChartSpec } from "../utils/chartSpec";
import "../css/chartViewer.css";

const getBaseUrl = () => {
  const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  return isLocalDev
    ? "http://localhost:5001"
    : (process.env.REACT_APP_FETCH_DATA_URL || "http://localhost:5001");
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

const extractStage = (payload, rawIndex = null) => {
  const stages = Array.isArray(payload?.stages) ? payload.stages : [];
  if (!stages.length) return { stage: null, index: 0 };
  const idx = Number.isFinite(Number(rawIndex))
    ? Math.min(Math.max(Number(rawIndex), 0), stages.length - 1)
    : Math.min(Math.max(Number(payload?.activeStageIndex || 0), 0), stages.length - 1);
  return { stage: stages[idx], index: idx };
};

const playReadyChime = () => {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.05, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    gain.connect(ctx.destination);

    [784, 1047].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + idx * 0.08);
      osc.connect(gain);
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.08 + 0.14);
    });

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 650);
  } catch (_) {
    // no-op: chime is optional
  }
};

const QnAPage = () => {
  const [time, setTime] = useState(getCurrentTime());
  const [chartSpec, setChartSpec] = useState(null);
  const [chartTitle, setChartTitle] = useState("Your Health Data");
  const [chartSubtitle, setChartSubtitle] = useState("");
  const [summary, setSummary] = useState("Ask a question and I'll summarize it in one or two sentences.");
  const [followUps, setFollowUps] = useState(["How did I sleep this week?"]);

  const [recentQuestion, setRecentQuestion] = useState("");
  const [recentAnswer, setRecentAnswer] = useState("");

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [chartLoading, setChartLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState(0);
  const [statusNotice, setStatusNotice] = useState(null);
  const [listening, setListening] = useState(false);
  const [voiceOk, setVoiceOk] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);

  const recRef = useRef(null);
  const chartReceivedForAskRef = useRef(false);
  const loadingTimerRef = useRef(null);
  const loadingTimeoutRef = useRef(null);
  const enrichTimerRef = useRef(null);
  const statusTimerRef = useRef(null);
  const readyChimedForAskRef = useRef(false);

  const username = localStorage.getItem("username") || "amy";

  const clearLoadingTimers = useCallback(() => {
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    if (loadingTimeoutRef.current) clearTimeout(loadingTimeoutRef.current);
    if (enrichTimerRef.current) clearTimeout(enrichTimerRef.current);
    loadingTimerRef.current = null;
    loadingTimeoutRef.current = null;
    enrichTimerRef.current = null;
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTime(getCurrentTime()), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setVoiceOk(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
  }, []);

  useEffect(() => () => clearLoadingTimers(), []);

  useEffect(() => {
    const onStatusUpdate = (event) => {
      const detail = event?.detail || {};
      const type = String(detail?.type || "").toLowerCase();
      const message = String(detail?.message || "").trim();

      if (type === "loading") {
        setStatusNotice(null);
        readyChimedForAskRef.current = false;
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
        return;
      }

      if (type === "completed") {
        setStatusNotice({
          type: "completed",
          message: message || "Your answer is ready.",
        });
        if (!readyChimedForAskRef.current) {
          readyChimedForAskRef.current = true;
          playReadyChime();
        }
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        statusTimerRef.current = setTimeout(() => {
          setStatusNotice(null);
          statusTimerRef.current = null;
        }, 5000);
        return;
      }

      if (type === "error") {
        setStatusNotice({
          type: "error",
          message: message || "I could not complete that request.",
        });
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        statusTimerRef.current = setTimeout(() => {
          setStatusNotice(null);
          statusTimerRef.current = null;
        }, 5000);
      }
    };

    window.addEventListener("visualStatusUpdate", onStatusUpdate);
    return () => {
      window.removeEventListener("visualStatusUpdate", onStatusUpdate);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    };
  }, []);

  const applyQnaPayload = useCallback((payload, stageIndexOverride = null, injectedSpeech = "") => {
    if (!payload || typeof payload !== "object") return;

    const { stage } = extractStage(payload, stageIndexOverride);
    const stageChart = stage?.chart_spec || payload?.chart_spec || null;
    if (!stageChart) return;

    const safeChart = validateChartSpec(stageChart, stageChart?.title || payload?.chart_spec?.title || "Your Health Data");

    chartReceivedForAskRef.current = true;
    setChartSpec(safeChart);
    setChartTitle(safeChart.title || "Your Health Data");
    setChartSubtitle(safeChart.subtitle || "");

    const spoken = String(
      injectedSpeech
      || stage?.voice_answer
      || payload?.voice_answer
      || safeChart.takeaway
      || ""
    ).trim();

    if (spoken) {
      setSummary(spoken);
      setRecentAnswer(spoken);
    }

    const stageFollowUps = Array.isArray(stage?.suggested_follow_up) ? stage.suggested_follow_up : [];
    const specFollowUps = Array.isArray(safeChart?.suggested_follow_up) ? safeChart.suggested_follow_up : [];
    const payloadFollowUps = Array.isArray(payload?.suggested_follow_up) ? payload.suggested_follow_up : [];
    const mergedFollowUps = [...stageFollowUps, ...specFollowUps, ...payloadFollowUps]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 4);

    if (mergedFollowUps.length) setFollowUps(mergedFollowUps);

    setChartLoading(false);
    setLoadingPhase(0);
    clearLoadingTimers();
  }, [clearLoadingTimers]);

  const loadSession = useCallback(() => {
    const raw = sessionStorage.getItem("qnaData");
    if (!raw) return;
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== "object") return;
    applyQnaPayload(parsed);
  }, [applyQnaPayload]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  useEffect(() => {
    const onUpdate = () => loadSession();
    const onStage = (e) => {
      const raw = sessionStorage.getItem("qnaData");
      if (!raw) return;
      const parsed = safeJsonParse(raw, null);
      if (!parsed || typeof parsed !== "object") return;

      const idx = Number(e.detail?.stageIndex);
      const speech = String(e.detail?.speech || "").trim();
      applyQnaPayload(parsed, Number.isFinite(idx) ? idx : null, speech);
    };

    window.addEventListener("qnaDataUpdated", onUpdate);
    window.addEventListener("qnaStage", onStage);
    return () => {
      window.removeEventListener("qnaDataUpdated", onUpdate);
      window.removeEventListener("qnaStage", onStage);
    };
  }, [applyQnaPayload, loadSession]);

  const ask = async (text) => {
    const q = String(text || "").trim();
    if (!q || busy) return;

    setBusy(true);
    setInput("");
    setRecentQuestion(q);
    setStatusNotice(null);
    readyChimedForAskRef.current = false;

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
        setSummary("It took too long to prepare your chart. Please try again.");
        setRecentAnswer("It took too long to prepare your chart. Please try again.");
      }
    }, 30000);

    try {
      await fetch(`${getBaseUrl()}/api/alexa/browser-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, question: q }),
      });
    } catch (_) {
      setChartLoading(false);
      setLoadingPhase(0);
      clearLoadingTimers();
      setSummary("I could not send that request. Please try again.");
      setRecentAnswer("I could not send that request. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    ask(input);
  };

  const onVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || listening) return;

    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    recRef.current = rec;

    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.onresult = (ev) => {
      const spoken = ev.results?.[0]?.[0]?.transcript;
      if (!spoken) return;
      setInput(spoken);
      ask(spoken);
    };

    rec.start();
  };

  const topSuggestion = followUps[0] || "How did I sleep this week?";
  const secondSuggestion = followUps[1] || "How does this compare with last week?";

  const highlightText = useMemo(() => {
    const h = chartSpec?.highlight;
    if (!h || typeof h !== "object") return "";
    const parts = [];
    if (h.label) parts.push(h.label);
    if (Number.isFinite(Number(h.value))) parts.push(`${Math.round(Number(h.value))}`);
    if (h.reason) parts.push(h.reason);
    return parts.join(" • ");
  }, [chartSpec]);

  return (
    <div className="hd-shell">
      <header className="hd-topbar">
        <span className="hd-time">{time}</span>
        <h1 className="hd-title">Health Assistant</h1>
        <span className="hd-user"><FiUser aria-hidden="true" /> Amy</span>
      </header>

      <main className="hd-main-grid" aria-label="Chart-first health QnA">
        <section className="hd-left-column" aria-label="Chart and summary">
          {statusNotice ? (
            <div className={`hd-ready-banner ${statusNotice.type || ""}`} role="status" aria-live="polite">
              {statusNotice.message}
            </div>
          ) : null}

          <section className="hd-chart-panel" aria-label="Health chart">
            <div className="hd-chart-head">
              <FiBarChart2 className="hd-chart-icon" aria-hidden="true" />
              <h2>{chartTitle}</h2>
            </div>

            {chartSubtitle ? <p className="hd-chart-subtitle">{chartSubtitle}</p> : null}

            <div className="hd-chart-canvas">
              {chartLoading ? (
                <div className="hd-chart-loading">
                  <div className="hd-loading-bar"><div className="hd-loading-fill" /></div>
                  <p className="hd-loading-message">
                    {loadingPhase === 1 ? "Thinking..." : loadingPhase === 2 ? "Fetching Fitbit data..." : "Building your chart..."}
                  </p>
                </div>
              ) : chartSpec ? (
                <EChartCard chartSpec={chartSpec} />
              ) : (
                <p className="hd-chart-empty">Ask a question to see your chart here.</p>
              )}
            </div>

            {highlightText ? (
              <div className="hd-highlight" aria-label="Highlighted point">Highlight: {highlightText}</div>
            ) : null}
          </section>

          <section className="hd-explanation" aria-label="Short explanation">
            <h3 className="hd-explanation-title">Summary</h3>
            <p className="hd-explanation-body">{summary}</p>

            {(recentQuestion || recentAnswer) ? (
              <div className="hd-recap" aria-label="Recap">
                {recentQuestion ? (
                  <div className="hd-recap-row">
                    <span className="hd-recap-label">You asked</span>
                    <span className="hd-recap-text">{recentQuestion}</span>
                  </div>
                ) : null}
                {recentAnswer ? (
                  <div className="hd-recap-row">
                    <span className="hd-recap-label">I said</span>
                    <span className="hd-recap-text">{recentAnswer}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </section>
      </main>

      <section className="hd-voice-dock" aria-label="Ask with voice">
        <div className="hd-voice-inner">
          <div className="hd-suggestion-row">
            <button
              type="button"
              className="hd-suggestion"
              onClick={() => ask(topSuggestion)}
              disabled={busy}
              aria-label={`Suggested: ${topSuggestion}`}
            >
              {topSuggestion}
            </button>
            {secondSuggestion ? (
              <button
                type="button"
                className="hd-suggestion hd-suggestion-alt"
                onClick={() => ask(secondSuggestion)}
                disabled={busy}
                aria-label={`Suggested: ${secondSuggestion}`}
              >
                {secondSuggestion}
              </button>
            ) : null}
          </div>

          <div className="hd-voice-row">
            <button
              type="button"
              className={`hd-mic-cta ${listening ? "hd-mic-active" : ""}`}
              onClick={onVoice}
              disabled={!voiceOk || busy}
              aria-label={listening ? "Listening" : "Tap to speak"}
              title={listening ? "Listening" : "Tap to speak"}
            >
              <FiMic aria-hidden="true" />
            </button>

            <div className="hd-voice-text">
              <div className="hd-voice-title">{listening ? "Listening..." : "Tap and speak"}</div>
              <div className="hd-voice-subtitle">
                {busy ? "Working on your answer..." : "Voice is primary. You can also type if needed."}
              </div>
            </div>

            <button
              type="button"
              className={`hd-kbd-toggle ${showKeyboard ? "hd-kbd-on" : ""}`}
              onClick={() => setShowKeyboard((v) => !v)}
              aria-label={showKeyboard ? "Hide keyboard" : "Type instead"}
              title={showKeyboard ? "Hide keyboard" : "Type instead"}
            >
              <FiType aria-hidden="true" />
            </button>
          </div>

          {showKeyboard ? (
            <div className="hd-input-bar hd-input-bar-compact" aria-label="Type a question">
              <form className="hd-input-form" onSubmit={onSubmit}>
                <input
                  type="text"
                  className="hd-input"
                  placeholder="Type your question (optional)..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={busy}
                  aria-label="Type your question"
                />
                <button
                  type="submit"
                  className="hd-send-btn"
                  disabled={busy || !input.trim()}
                  aria-label="Send question"
                >
                  <FiSend aria-hidden="true" />
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </section>

      <footer className="hd-footer" role="contentinfo">Not medical advice.</footer>
    </div>
  );
};

export default QnAPage;
