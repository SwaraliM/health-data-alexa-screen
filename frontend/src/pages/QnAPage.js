import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FiUser } from "react-icons/fi";
import EChartCard from "../components/EChartCard";
import { getCurrentTime } from "../utils/getCurrentTime";
import { validateChartSpec } from "../utils/chartSpec";
import "../css/chartViewer.css";

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

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const rawPanels = derivePanelsFromLegacy(payload);
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

  const activePanelId = payload?.activePanelId || panels[Number(payload?.activeStageIndex) || 0]?.panel_id || panels[0]?.panel_id || null;

  return {
    ...payload,
    response_mode: responseMode,
    layout,
    panels,
    activePanelId,
    spoken_answer: payload?.spoken_answer || payload?.voice_answer || payload?.summary?.shortSpeech || "",
    takeaway: payload?.takeaway || payload?.primary_answer || payload?.summary?.shortText || payload?.primary_visual?.takeaway || "",
    report_title: payload?.report_title || payload?.primary_visual?.title || "Health report",
  };
}

const QnAPage = () => {
  const [time, setTime] = useState(getCurrentTime());
  const [payload, setPayload] = useState(null);
  const [summary, setSummary] = useState("Chart view will appear here when a health question is answered.");
  const [chartLoading, setChartLoading] = useState(false);
  const [statusNotice, setStatusNotice] = useState(null);
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
      if (detail?.type === "completed" || detail?.type === "error") {
        setStatusNotice({
          type: detail.type,
          message: String(detail.message || "").trim(),
        });
        if (detail.type === "completed") setChartLoading(false);
      }
    };
    window.addEventListener("qnaDataUpdated", onUpdate);
    window.addEventListener("visualStatusUpdate", onStatus);
    return () => {
      window.removeEventListener("qnaDataUpdated", onUpdate);
      window.removeEventListener("visualStatusUpdate", onStatus);
    };
  }, [applyPayload]);

  const panels = useMemo(() => payload?.panels || [], [payload]);
  const activePanel = useMemo(
    () => panels.find((panel) => panel.panel_id === payload?.activePanelId) || panels[0] || null,
    [panels, payload?.activePanelId]
  );
  const visiblePanels = payload?.response_mode === "single_view"
    ? (activePanel ? [activePanel] : panels.slice(0, 1))
    : panels;
  const panelCount = visiblePanels.length || 1;
  const gridHeroClass = panelCount === 2 && visiblePanels[0]?.emphasis === "hero" ? "hd-grid-hero-first" : "";

  return (
    <div className="hd-shell">
      <div className="hd-frame">
        <header className="hd-topbar">
          <div className="hd-time">{time}</div>
          <h1 className="hd-title">Health Q and A</h1>
          <div className="hd-user"><FiUser /> {username}</div>
        </header>

        <main className={`hd-main hd-main-chart-only hd-layout-${payload?.layout || "single_focus"}`}>
          {statusNotice?.message ? (
            <div className={`hd-ready-banner ${statusNotice.type}`}>
              {statusNotice.message}
            </div>
          ) : null}

          <section className="hd-report-header hd-report-header-compact">
            <div>
              <p className="hd-report-eyebrow">{payload?.response_mode === "multi_panel_report" ? "Visual report" : "Focused answer"}</p>
              <h2 className="hd-report-title">{payload?.report_title || "Health report"}</h2>
            </div>
            <p className="hd-report-takeaway">{payload?.takeaway || summary}</p>
          </section>

          <section className={`hd-panel-grid hd-panel-grid-${payload?.layout || "single_focus"} hd-panel-count-${panelCount} ${gridHeroClass}`.trim()}>
            {chartLoading ? (
              <div className="hd-chart-loading hd-loading-panel">
                <div className="hd-loading-bar"><div className="hd-loading-fill" /></div>
                <p className="hd-loading-message">Preparing chart view.</p>
              </div>
            ) : (
              visiblePanels.map((panel, index) => (
                <article
                  key={panel.panel_id || index}
                  className={`hd-panel-card hd-panel-slot-${index + 1} hd-panel-emphasis-${panel.emphasis || "standard"} ${panel.panel_id === payload?.activePanelId ? "is-active" : ""}`.trim()}
                  style={{
                    "--hd-panel-accent": panel?.chart_spec?.panel_theme?.accentColor || "",
                    "--hd-panel-border": panel?.chart_spec?.panel_theme?.borderColor || "",
                    "--hd-panel-bg": panel?.chart_spec?.panel_theme?.backgroundColor || "",
                  }}
                >
                  <div className="hd-panel-copy">
                    <h3>{panel.title}</h3>
                    {panel.subtitle ? <p>{panel.subtitle}</p> : null}
                  </div>
                  <div className="hd-panel-chart">
                    <EChartCard chartSpec={panel.chart_spec} />
                  </div>
                </article>
              ))
            )}
          </section>

        </main>
      </div>
    </div>
  );
};

export default QnAPage;
