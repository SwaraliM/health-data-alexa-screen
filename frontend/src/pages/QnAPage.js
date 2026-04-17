import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiUser } from "react-icons/fi";
import EChartCard from "../components/EChartCard";
import { getCurrentTime } from "../utils/getCurrentTime";
import { validateChartSpec } from "../utils/chartSpec";
import "../css/chartViewer.css";
import "../css/tabletSingleView.css";

const QNA_SPOKEN_REQUEST_STORAGE_KEY = "qnaLastSpokenRequestId";
const VISUAL_STATUS_STORAGE_KEY = "visualStatus";
const VISUAL_STATUS_TTL_MS = 30 * 1000;

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

const toNonNegativeInt = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
};

const derivePanelsFromLegacy = (payload) => {
  const fromPanels = Array.isArray(payload?.panels) ? payload.panels : [];
  if (fromPanels.length) return fromPanels;
  const primaryVisual = payload?.primary_visual || payload?.chart_spec || payload?.stages?.[0]?.chart_spec || null;
  if (!primaryVisual) return [];
  return [{
    panel_id: payload?.activePanelId || "primary",
    title: primaryVisual.title || "Health summary",
    subtitle: primaryVisual.subtitle || "",
    goal: payload?.question_type || "single_metric_status",
    metrics: Array.isArray(payload?.metrics_needed) ? payload.metrics_needed.slice(0, 4) : [],
    visual_family: primaryVisual.chart_type || "bar",
    chart_spec: primaryVisual,
  }];
};

const prioritizeTimelinePanelForThreePanelView = (panels) => {
  if (!Array.isArray(panels) || panels.length !== 3) return Array.isArray(panels) ? panels : [];
  const timelineIndex = panels.findIndex((panel) => {
    const visualFamily = panel?.visual_family || panel?.chart_spec?.chart_type || panel?.chart_type;
    return visualFamily === "timeline";
  });
  if (timelineIndex === -1) return panels;
  const reordered = panels.slice();
  if (timelineIndex > 0) {
    const [timelinePanel] = reordered.splice(timelineIndex, 1);
    reordered.unshift(timelinePanel);
  }
  return reordered.map((panel, index) => ({
    ...panel,
    emphasis: index === 0 ? "hero" : "standard",
  }));
};

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const rawPanels = prioritizeTimelinePanelForThreePanelView(derivePanelsFromLegacy(payload));
  const explicitActiveStageIndex = toNonNegativeInt(
    payload?.activeStageIndex ?? payload?.currentStageIndex,
    null
  );
  const explicitStageCount = toNonNegativeInt(payload?.stageCount, null);
  const stageListCount = Array.isArray(payload?.stages) ? payload.stages.length : 0;
  const hasStageMetadata = explicitActiveStageIndex != null
    || explicitStageCount != null
    || stageListCount > 1;

  const panels = rawPanels.map((panel, index) => ({
    ...panel,
    chart_spec: validateChartSpec(
      panel?.chart_spec || panel,
      panel?.title || payload?.report_title || payload?.primary_visual?.title || "Health report"
    ),
    panel_id: panel?.panel_id || `panel_${index + 1}`,
    title: panel?.title || panel?.chart_spec?.title || `Panel ${index + 1}`,
    subtitle: panel?.subtitle || panel?.chart_spec?.subtitle || "",
    goal: panel?.goal || "single_metric_status",
    metrics: Array.isArray(panel?.metrics) ? panel.metrics : [],
    visual_family: panel?.visual_family || panel?.chart_spec?.chart_type || "bar",
    emphasis: panel?.emphasis === "hero" ? "hero" : (rawPanels.length === 3 && index === 0 ? "hero" : "standard"),
  }));

  const responseMode = payload?.response_mode || (panels.length > 1 ? "multi_panel_report" : "single_view");
  const layout = payload?.layout || (panels.length >= 4
    ? "four_panel_grid"
    : panels.length === 3
      ? "two_up_plus_footer"
      : panels.length === 2
        ? "two_up"
        : "single_focus");

  const fallbackStageIndex = explicitActiveStageIndex ?? 0;
  const clampedStageIndex = panels.length
    ? Math.min(fallbackStageIndex, panels.length - 1)
    : 0;
  const activePanelId = explicitActiveStageIndex != null
    ? (panels[clampedStageIndex]?.panel_id || payload?.activePanelId || panels[0]?.panel_id || null)
    : (payload?.activePanelId || panels[clampedStageIndex]?.panel_id || panels[0]?.panel_id || null);
  const moreAvailable = Boolean(payload?.moreAvailable || payload?.more_available);
  const stageCount = Math.max(
    explicitStageCount ?? 0,
    stageListCount,
    panels.length,
    moreAvailable ? (explicitActiveStageIndex ?? 0) + 2 : 0
  );

  return {
    ...payload,
    response_mode: responseMode,
    layout,
    panels,
    stageCount,
    activeStageIndex: clampedStageIndex,
    activePanelId,
    stagedFlow: hasStageMetadata && stageCount > 1,
    spoken_answer: payload?.spoken_answer || payload?.voice_answer || payload?.summary?.shortSpeech || "",
    takeaway: payload?.takeaway || payload?.primary_answer || payload?.summary?.shortText || payload?.primary_visual?.takeaway || "",
    report_title: payload?.report_title || payload?.primary_visual?.title || "Health report",
  };
}

function getPayloadSpeechText(nextPayload) {
  return String(
    nextPayload?.spoken_answer
    || nextPayload?.voice_answer
    || nextPayload?.takeaway
    || nextPayload?.summary?.shortSpeech
    || ""
  ).trim();
}

function getPayloadSpeechKey(nextPayload) {
  const requestId = String(nextPayload?.requestId || "").trim();
  if (requestId) return requestId;
  const speechText = getPayloadSpeechText(nextPayload);
  if (!speechText) return "";
  return `${String(nextPayload?.report_title || "health-report").trim()}::${speechText}`;
}

function speakAnswer(text) {
  if (!text || typeof window === "undefined") return false;
  const synth = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!synth || typeof synth.speak !== "function" || typeof Utterance !== "function") return false;
  synth.cancel?.();
  const utterance = new Utterance(text);
  utterance.rate = 1;
  synth.speak(utterance);
  return true;
}

const QnAPage = () => {
  const [time, setTime] = useState(getCurrentTime());
  const [payload, setPayload] = useState(null);
  const [summary, setSummary] = useState("Chart view will appear here when a health question is answered.");
  const [chartLoading, setChartLoading] = useState(false);
  const [statusNotice, setStatusNotice] = useState(null);
  const spokenRequestRef = useRef(sessionStorage.getItem(QNA_SPOKEN_REQUEST_STORAGE_KEY) || "");
  const username = localStorage.getItem("username") || "amy";

  useEffect(() => {
    const timer = setInterval(() => setTime(getCurrentTime()), 60000);
    return () => clearInterval(timer);
  }, []);

  const applyPayload = useCallback((nextPayload) => {
    if (nextPayload?.loading === true) {
      setPayload({ loading: true, question: nextPayload.question });
      setSummary("Preparing chart view.");
      setChartLoading(true);
      setStatusNotice(null);
      return;
    }
    const normalized = normalizePayload(nextPayload);
    if (!normalized) return;
    setPayload(normalized);
    setSummary(normalized.spoken_answer || normalized.takeaway || "Chart view ready.");
    setChartLoading(false);
  }, []);

  useEffect(() => {
    const parsed = safeJsonParse(sessionStorage.getItem("qnaData"), null);
    if (parsed) applyPayload(parsed);
  }, [applyPayload]);

  useEffect(() => {
    const storedStatus = safeJsonParse(sessionStorage.getItem(VISUAL_STATUS_STORAGE_KEY), null);
    if (!storedStatus?.message) return;
    if (Date.now() - Number(storedStatus.timestamp || 0) > VISUAL_STATUS_TTL_MS) {
      sessionStorage.removeItem(VISUAL_STATUS_STORAGE_KEY);
      return;
    }
    setStatusNotice({
      type: String(storedStatus.type || "info").trim(),
      message: String(storedStatus.message || "").trim(),
    });
  }, []);

  useEffect(() => {
    const onUpdate = () => {
      const parsed = safeJsonParse(sessionStorage.getItem("qnaData"), null);
      if (parsed) applyPayload(parsed);
    };
    const onStatus = (event) => {
      const detail = event?.detail || {};
      if (detail?.type === "loading") {
        setStatusNotice(null);
        setChartLoading(true);
        return;
      }
      if (detail?.message) {
        setStatusNotice({
          type: String(detail.type || "info").trim(),
          message: String(detail.message || "").trim(),
        });
        if (detail.type === "completed" || detail.type === "error") setChartLoading(false);
      }
    };
    window.addEventListener("qnaDataUpdated", onUpdate);
    window.addEventListener("visualStatusUpdate", onStatus);
    return () => {
      window.removeEventListener("qnaDataUpdated", onUpdate);
      window.removeEventListener("visualStatusUpdate", onStatus);
    };
  }, [applyPayload]);

  useEffect(() => {
    if (!payload || payload.loading || chartLoading || !payload.answer_ready) return undefined;
    // When auto-advance is active, per-stage speech is handled by the auto-advance effect below
    if (payload?.autoAdvance && Array.isArray(payload?.stages) && payload.stages.length > 1) return undefined;
    const speechText = getPayloadSpeechText(payload);
    const speechKey = getPayloadSpeechKey(payload);
    if (!speechText || !speechKey || spokenRequestRef.current === speechKey) return undefined;

    const speechTimer = setTimeout(() => {
      spokenRequestRef.current = speechKey;
      sessionStorage.setItem(QNA_SPOKEN_REQUEST_STORAGE_KEY, speechKey);
      speakAnswer(speechText);
    }, 180);

    return () => clearTimeout(speechTimer);
  }, [chartLoading, payload]);

  // Auto-advance: cycle through stages synchronized with Alexa narration or browser TTS
  const [autoAdvanceIndex, setAutoAdvanceIndex] = useState(0);

  useEffect(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setAutoAdvanceIndex(0);

    const stages = Array.isArray(payload?.stages) ? payload.stages : [];
    if (!payload?.autoAdvance || stages.length <= 1) return undefined;
    if (payload.loading || chartLoading || !payload.answer_ready) return undefined;

    // Dedup — don't re-run if we already handled this payload
    const speechKey = getPayloadSpeechKey(payload);
    if (speechKey && spokenRequestRef.current === speechKey) return undefined;
    spokenRequestRef.current = speechKey;
    sessionStorage.setItem(QNA_SPOKEN_REQUEST_STORAGE_KEY, speechKey);

    let cancelled = false;
    const schedule = Array.isArray(payload?.chartAdvanceSchedule) ? payload.chartAdvanceSchedule : [];

    // ── Alexa-narrated: advance charts on pre-computed schedule ──────────
    // Alexa speaks the combined SSML; we advance charts at estimated offsets.
    // 1.5s initial delay accounts for Alexa processing before speech starts.
    if (schedule.length > 1) {
      const ALEXA_PROCESSING_DELAY = 1500;
      const timers = schedule.map(({ stageIndex, offsetMs }) =>
        setTimeout(() => {
          if (!cancelled) setAutoAdvanceIndex(stageIndex);
        }, ALEXA_PROCESSING_DELAY + offsetMs)
      );

      return () => {
        cancelled = true;
        timers.forEach(clearTimeout);
      };
    }

    // ── Browser TTS fallback: advance charts driven by speech events ────
    const hasTTS = typeof window !== "undefined" && window.speechSynthesis
      && typeof window.SpeechSynthesisUtterance === "function";

    function speakStage(index) {
      if (cancelled || index >= stages.length) return;
      setAutoAdvanceIndex(index);

      const stageText = stages[index]?.speech || stages[index]?.voice_answer || "";
      if (!stageText) {
        setTimeout(() => { if (!cancelled) speakStage(index + 1); }, 500);
        return;
      }

      if (!hasTTS) {
        setTimeout(() => { if (!cancelled) speakStage(index + 1); }, 10000);
        return;
      }

      const synth = window.speechSynthesis;
      const utterance = new window.SpeechSynthesisUtterance(stageText);
      utterance.rate = 1;
      utterance.onend = () => { if (!cancelled) speakStage(index + 1); };
      utterance.onerror = () => { if (!cancelled) speakStage(index + 1); };
      synth.speak(utterance);
    }

    const startTimer = setTimeout(() => speakStage(0), 300);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, [payload?.autoAdvance, payload?.stages, payload?.answer_ready, chartLoading]);

  // Build panels from stages for auto-advance, or use existing panels
  const allStagePanels = useMemo(() => {
    const stages = Array.isArray(payload?.stages) ? payload.stages : [];
    if (!payload?.autoAdvance || stages.length <= 1) return null;
    return stages.map((stage, idx) => ({
      panel_id: `stage_${stage.stageIndex ?? idx}`,
      title: stage.title || `Chart ${idx + 1}`,
      subtitle: "",
      goal: "deep_dive",
      metrics: [],
      visual_family: stage.chart_spec?.chart_type || "bar",
      chart_spec: validateChartSpec(
        stage.chart_spec || stage,
        stage.title || "Health insight"
      ),
    }));
  }, [payload?.autoAdvance, payload?.stages]);

  const panels = useMemo(() => payload?.panels || [], [payload]);
  const activePanel = useMemo(() => {
    if (allStagePanels && allStagePanels.length > 0) {
      return allStagePanels[autoAdvanceIndex] || allStagePanels[0] || null;
    }
    return panels.find((panel) => panel.panel_id === payload?.activePanelId) || panels[0] || null;
  }, [panels, payload?.activePanelId, allStagePanels, autoAdvanceIndex]);

  // Show all panels simultaneously when the backend sends a multi-panel layout.
  // Only collapse to single-panel when the backend explicitly sets voice_navigation_only.
  const shouldShowSinglePanel = payload?.voice_navigation_only === true
    || payload?.response_mode === "single_view"
    || payload?.stagedFlow;
  const visiblePanels = shouldShowSinglePanel
    ? (activePanel ? [activePanel] : panels.slice(0, 1))
    : panels;
  const panelCount = visiblePanels.length || 1;
  const isSinglePanel = panelCount === 1;
  const renderedLayout = isSinglePanel ? "single_focus" : (payload?.layout || "single_focus");
  const gridHeroClass = panelCount === 2 && visiblePanels[0]?.emphasis === "hero" ? "hd-grid-hero-first" : "";
  const activeStageNumber = payload?.autoAdvance
    ? autoAdvanceIndex + 1
    : (toNonNegativeInt(payload?.activeStageIndex, 0) || 0) + 1;
  const stageCount = Math.max(1, toNonNegativeInt(payload?.stageCount, panels.length || 1) || 1);
  const bundleComplete = payload?.bundle_complete === true || (payload?.autoAdvance && autoAdvanceIndex >= stageCount - 1);
  const showReadyResumePage = statusNotice?.type === "ready_to_resume" && Boolean(statusNotice?.message);

  return (
    <div className="hd-shell">
      <div className="hd-frame">
        <header className="hd-topbar">
          <div className="hd-time">{time}</div>
          <h1 className="hd-title">Health Q and A</h1>
          <div className="hd-user"><FiUser /> {username}</div>
        </header>

        <main className={`hd-main hd-main-chart-only hd-layout-${renderedLayout} ${isSinglePanel ? "hd-main-single-panel" : ""} ${showReadyResumePage ? "hd-main-ready-resume" : ""}`.trim()}>
          {showReadyResumePage ? (
            <section className="hd-ready-resume-page" aria-live="polite" aria-label="Answer ready">
              <div className="hd-ready-resume-card">
                <p className="hd-ready-resume-eyebrow">Your answer is ready</p>
                <h2 className="hd-ready-resume-title">Alexa is ready to continue</h2>
                <p className="hd-ready-resume-message">{statusNotice.message}</p>
                <p className="hd-ready-resume-instruction">Say, “Alexa, continue” when you are ready.</p>
              </div>
            </section>
          ) : statusNotice?.message ? (
            <div className={`hd-ready-banner ${statusNotice.type}`}>
              {statusNotice.message}
            </div>
          ) : null}

          {!showReadyResumePage ? (
          <section className={`hd-report-header hd-report-header-compact ${isSinglePanel ? "hd-report-header-single-panel" : ""}`.trim()}>
            <div>
              <h2 className="hd-report-title">{payload?.report_title || "Health report"}</h2>
              <p className="hd-stage-counter">Chart {activeStageNumber} of {stageCount}</p>
            </div>
            <p className="hd-report-takeaway">{payload?.takeaway || summary}</p>
          </section>
          ) : null}

          {!showReadyResumePage ? (
          <section className="hd-voice-hints" aria-label="Voice commands">
            <div className="hd-voice-hints-row">
              {!bundleComplete && (
                <span className="hd-voice-hint-chip hd-hint-primary">Say "next" for next chart</span>
              )}
              <span className="hd-voice-hint-chip">Say "go deeper" for analysis</span>
              <span className="hd-voice-hint-chip">Ask any question about this chart</span>
            </div>
          </section>
          ) : null}

          {!showReadyResumePage ? (
          <section className={`hd-panel-grid hd-panel-grid-${renderedLayout} hd-panel-count-${panelCount} ${gridHeroClass} ${isSinglePanel ? "hd-panel-grid-single-panel" : ""}`.trim()}>
            {chartLoading ? (
              <div className="hd-chart-loading hd-loading-panel">
                <div className="hd-loading-bar"><div className="hd-loading-fill" /></div>
                <p className="hd-loading-message">Preparing chart view.</p>
              </div>
            ) : (
              visiblePanels.map((panel, index) => (
                <article
                  key={panel.panel_id || index}
                  className={`hd-panel-card hd-panel-slot-${index + 1} hd-panel-emphasis-${panel.emphasis || "standard"} ${panel.panel_id === payload?.activePanelId ? "is-active" : ""} ${isSinglePanel ? "hd-panel-card-single-panel" : ""}`.trim()}
                  style={{
                    "--hd-panel-accent": panel?.chart_spec?.panel_theme?.accentColor || "",
                    "--hd-panel-border": panel?.chart_spec?.panel_theme?.borderColor || "",
                    "--hd-panel-bg": panel?.chart_spec?.panel_theme?.backgroundColor || "",
                  }}
                >
                  {!isSinglePanel ? (
                    <div className="hd-panel-copy">
                      <h3>{panel.title}</h3>
                      {panel.subtitle ? <p>{panel.subtitle}</p> : null}
                    </div>
                  ) : null}
                  <div className={`hd-panel-chart ${isSinglePanel ? "hd-panel-chart-single-panel" : ""}`.trim()}>
                    <EChartCard chartSpec={panel.chart_spec} className={isSinglePanel ? "hd-echart-single-panel" : ""} />
                  </div>
                </article>
              ))
            )}
          </section>
          ) : null}

        </main>
      </div>
    </div>
  );
};

export default QnAPage;
