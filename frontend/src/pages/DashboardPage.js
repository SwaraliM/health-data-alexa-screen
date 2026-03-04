import React, { useMemo, useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import SmartScreenShell from "../components/smartScreen/SmartScreenShell";
import TopBar from "../components/smartScreen/TopBar";
import InsightCard from "../components/smartScreen/InsightCard";
import QuickStatTile from "../components/smartScreen/QuickStatTile";
import ReminderIconsPanel from "../components/smartScreen/ReminderIconsPanel";
import RemindersModal from "../components/smartScreen/RemindersModal";
import WeeklyTrendsButtonRow from "../components/smartScreen/WeeklyTrendsButtonRow";
import WeeklyTrendsModal from "../components/smartScreen/WeeklyTrendsModal";
import { getCurrentDate } from "../utils/getCurrentDate";
import { getCurrentTime } from "../utils/getCurrentTime";

const getBaseUrl = () => {
  const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  return isLocalDev ? "http://localhost:5001" : (process.env.REACT_APP_FETCH_DATA_URL || "http://localhost:5001");
};

const fetchJson = async (url) => {
  const res = await fetch(url, {
    method: "GET",
    headers: { "ngrok-skip-browser-warning": "true" },
  });
  const text = await res.text();
  if (text.trim().startsWith("<!") || text.trim().startsWith("<html")) return null;
  if (!res.ok) return null;
  return JSON.parse(text);
};

const formatDate = (dateObj) => {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const day = String(dateObj.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getDateRange = (endDateStr, daysBack) => {
  const endDate = new Date(`${endDateStr}T00:00:00`);
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - daysBack);
  return { startDate: formatDate(startDate), endDate: formatDate(endDate) };
};

const getWeekdayLabel = (dateStr) => {
  const weekday = new Date(`${dateStr}T00:00:00`).getDay();
  return ["S", "M", "T", "W", "Th", "F", "S"][weekday];
};

const statusFor = (value, goalValue, hasData = true) => {
  if (!hasData || goalValue <= 0) return { status: "no_data", tone: "no-data" };
  const ratio = value / goalValue;
  if (ratio >= 0.8) return { status: "on_track", tone: "on-track" };
  if (ratio >= 0.5) return { status: "watch", tone: "watch" };
  return { status: "needs_attention", tone: "needs-attention" };
};

const normalizeReminderCategory = (item) => {
  const category = String(item?.category || "").toLowerCase();
  const title = String(item?.title || "").toLowerCase();

  if (category === "medication" || /pill|medicine|tablet|capsule|vitamin|dose/.test(title)) return "medications";
  if (category === "hydration" || /hydrate|water/.test(title)) return "hydration";
  if (category === "activity" || /walk|exercise|cardio|run|workout|stretch/.test(title)) return "activity";
  if (/appointment|doctor|clinic|visit|hospital/.test(title)) return "appointments";
  if (category === "task" || category === "custom") return "appointments";
  return "more";
};

const DashboardPage = () => {
  const { username: routeUsername } = useParams();
  const username = routeUsername || "amy";

  const [currentTime, setCurrentTime] = useState(getCurrentTime());
  const [summary, setSummary] = useState(null);
  const [sleepData, setSleepData] = useState(null);
  const [weeklySteps, setWeeklySteps] = useState(null);
  const [monthlySteps, setMonthlySteps] = useState(null);
  const [weeklySleep, setWeeklySleep] = useState(null);
  const [monthlySleep, setMonthlySleep] = useState(null);
  const [medications, setMedications] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(true);

  const [remindersOpen, setRemindersOpen] = useState(false);
  const [activeReminderCategory, setActiveReminderCategory] = useState("medications");
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  const [activeTrendTab, setActiveTrendTab] = useState("steps");
  const [trendTimeframe, setTrendTimeframe] = useState("week");
  const [actionLoadingById, setActionLoadingById] = useState({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnswer, setAiAnswer] = useState(null);

  const date = getCurrentDate();
  const { startDate: weekStartDate, endDate } = useMemo(() => getDateRange(date, 6), [date]);
  const { startDate: monthStartDate } = useMemo(() => getDateRange(date, 29), [date]);
  const baseUrl = getBaseUrl();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [
      summaryRes,
      sleepRes,
      weeklyStepsRes,
      monthlyStepsRes,
      medsRes,
      remindersRes,
      weeklySleepRes,
      monthlySleepRes,
    ] = await Promise.all([
      fetchJson(`${baseUrl}/api/fitbit/${username}/activities/summary/${date}`).catch(() => null),
      fetchJson(`${baseUrl}/api/fitbit/${username}/sleep/single-day/date/${date}`).catch(() => null),
      fetchJson(`${baseUrl}/api/fitbit/${username}/activities/period/steps/date/${date}/7d`).catch(() => null),
      fetchJson(`${baseUrl}/api/fitbit/${username}/activities/period/steps/date/${date}/30d`).catch(() => null),
      fetchJson(`${baseUrl}/api/med/all/${username}`).catch(() => null),
      fetchJson(`${baseUrl}/api/reminder/${username}`).catch(() => null),
      fetchJson(`${baseUrl}/api/fitbit/${username}/sleep/range/date/${weekStartDate}/${endDate}`).catch(() => null),
      fetchJson(`${baseUrl}/api/fitbit/${username}/sleep/range/date/${monthStartDate}/${endDate}`).catch(() => null),
    ]);

    if (summaryRes) setSummary(summaryRes);
    if (sleepRes) setSleepData(sleepRes);
    if (weeklyStepsRes) setWeeklySteps(weeklyStepsRes);
    if (monthlyStepsRes) setMonthlySteps(monthlyStepsRes);
    if (Array.isArray(medsRes)) setMedications(medsRes);
    else setMedications([]);
    if (Array.isArray(remindersRes)) setReminders(remindersRes);
    else setReminders([]);
    if (weeklySleepRes) setWeeklySleep(weeklySleepRes);
    if (monthlySleepRes) setMonthlySleep(monthlySleepRes);

    setLoading(false);
  }, [baseUrl, username, date, weekStartDate, monthStartDate, endDate]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const t = setInterval(() => setCurrentTime(getCurrentTime()), 60000);
    return () => clearInterval(t);
  }, []);

  const pct = (val, goalValue) => (goalValue > 0 ? Math.min(100, (val / goalValue) * 100) : 0);

  const steps = summary?.summary?.steps ?? 0;
  const stepGoal = summary?.goals?.steps ?? 5000;

  const distanceMi = (() => {
    const distances = summary?.summary?.distances;
    if (Array.isArray(distances)) {
      const total = distances.find((entry) => entry.activity === "total");
      return total?.distance ?? 0;
    }
    return 0;
  })();

  const distanceGoal = summary?.goals?.distance ?? 8;
  const floors = summary?.summary?.floors ?? 0;
  const floorGoal = summary?.goals?.floors ?? 10;

  const sleepMinutes = (() => {
    if (!sleepData) return 0;
    if (sleepData.summary?.totalMinutesAsleep != null) return sleepData.summary.totalMinutesAsleep;
    if (Array.isArray(sleepData.sleep) && sleepData.sleep.length > 0) {
      return sleepData.sleep.reduce((sum, s) => sum + (s.minutesAsleep ?? 0), 0);
    }
    return 0;
  })();

  const sleepHrs = Math.floor(sleepMinutes / 60);
  const sleepMins = sleepMinutes % 60;
  const sleepDisplay = sleepMinutes > 0 ? `${sleepHrs}h ${sleepMins}m` : "—";
  const sleepGoalMinutes = 7 * 60;

  const activityText = steps >= stepGoal * 0.8 ? "High" : steps >= stepGoal * 0.5 ? "Moderate" : "Low";
  const suggestionText = steps >= stepGoal * 0.8 ? "Keep your routine steady" : "Light cardio and hydrate";

  const stepsStatus = statusFor(steps, stepGoal, Number.isFinite(steps) && steps > 0);
  const sleepStatus = statusFor(sleepMinutes, sleepGoalMinutes, sleepMinutes > 0);
  const distanceStatus = statusFor(distanceMi, distanceGoal, Number.isFinite(distanceMi) && distanceMi > 0);
  const floorsStatus = statusFor(floors, floorGoal, Number.isFinite(floors) && floors > 0);

  const reminderItems = useMemo(() => {
    const medItems = Array.isArray(medications)
      ? medications.map((medication, index) => ({
          id: medication._id || `med-${index}`,
          source: "medication",
          categoryKey: "medications",
          categoryLabel: "Medication",
          title: medication.name || "Medication",
          displayTime: medication?.schedule?.rules?.[0]?.timeOfDay || medication.nextDoseTime || "Scheduled",
          nextTriggerAt: medication?.schedule?.rules?.[0]?.startAt || null,
          statusLabel: "Active",
          raw: medication,
        }))
      : [];

    const reminderRows = Array.isArray(reminders)
      ? reminders
          .filter((item) => item?.status !== "archived")
          .map((item, index) => {
            const categoryKey = normalizeReminderCategory(item);
            const categoryLabelMap = {
              medications: "Medication",
              activity: "Activity",
              hydration: "Hydration",
              appointments: "Appointment",
              more: "General",
            };

            return {
              id: item._id || `rem-${index}`,
              source: "reminder",
              categoryKey,
              categoryLabel: categoryLabelMap[categoryKey],
              title: item.title || "Reminder",
              displayTime: item?.schedule?.rules?.[0]?.timeOfDay || "Scheduled",
              nextTriggerAt: item.nextTriggerAt || item.currentDueAt || null,
              statusLabel: item.status || "active",
              raw: item,
            };
          })
      : [];

    return [...medItems, ...reminderRows].sort((a, b) => {
      const aTime = a.nextTriggerAt ? new Date(a.nextTriggerAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.nextTriggerAt ? new Date(b.nextTriggerAt).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
  }, [medications, reminders]);

  const reminderCategoryCounts = useMemo(() => {
    const base = {
      medications: 0,
      activity: 0,
      hydration: 0,
      appointments: 0,
      more: 0,
    };
    reminderItems.forEach((item) => {
      if (base[item.categoryKey] == null) base.more += 1;
      else base[item.categoryKey] += 1;
    });
    return base;
  }, [reminderItems]);

  const reminderCategories = useMemo(() => {
    const baseCategories = [
      { key: "medications", count: reminderCategoryCounts.medications },
      { key: "activity", count: reminderCategoryCounts.activity },
      { key: "hydration", count: reminderCategoryCounts.hydration },
      { key: "appointments", count: reminderCategoryCounts.appointments },
    ];

    if (reminderCategoryCounts.more > 0) {
      return [...baseCategories, { key: "more", count: reminderCategoryCounts.more }];
    }
    return baseCategories;
  }, [reminderCategoryCounts]);

  const getPointsFromSeries = (series = [], key = "value", count = 7) => {
    const clipped = Array.isArray(series) ? series.slice(-count) : [];
    return clipped.map((entry) => Number(entry?.[key]) || 0);
  };

  const getSleepPoints = (sleepRangeRes, count = 7) => {
    const logs = Array.isArray(sleepRangeRes?.sleep) ? sleepRangeRes.sleep : [];
    const byDate = {};
    logs.forEach((entry) => {
      const dateKey = entry.dateOfSleep || entry.dateTime;
      if (!dateKey) return;
      const existing = byDate[dateKey];
      if (!existing || entry.isMainSleep || (entry.duration ?? 0) > (existing.duration ?? 0)) {
        byDate[dateKey] = entry;
      }
    });
    const dates = Object.keys(byDate).sort().slice(-count);
    return {
      labels: dates.map(getWeekdayLabel),
      points: dates.map((dateKey) => Math.round((byDate[dateKey]?.minutesAsleep || 0) / 60)),
    };
  };

  const weeklyStepSeries = Array.isArray(weeklySteps?.["activities-steps"]) ? weeklySteps["activities-steps"] : [];
  const monthlyStepSeries = Array.isArray(monthlySteps?.["activities-steps"]) ? monthlySteps["activities-steps"] : [];

  const weekSleep = getSleepPoints(weeklySleep, 7);
  const monthSleep = getSleepPoints(monthlySleep, 30);

  const weeklyTrendData = {
    steps: {
      key: "steps",
      labels: weeklyStepSeries.slice(-7).map((d) => getWeekdayLabel(d.dateTime)),
      points: getPointsFromSeries(weeklyStepSeries, "value", 7),
      goal: stepGoal,
      unit: "steps",
    },
    sleep: {
      key: "sleep",
      labels: weekSleep.labels,
      points: weekSleep.points,
      goal: 7,
      unit: "hrs",
    },
    routine: {
      key: "routine",
      labels: weeklyStepSeries.slice(-7).map((d) => getWeekdayLabel(d.dateTime)),
      points: getPointsFromSeries(weeklyStepSeries, "value", 7).map((value) => Math.min(100, Math.round((value / Math.max(stepGoal, 1)) * 100))),
      goal: 80,
      unit: "%",
    },
    activity: {
      key: "activity",
      labels: weeklyStepSeries.slice(-7).map((d) => getWeekdayLabel(d.dateTime)),
      points: getPointsFromSeries(weeklyStepSeries, "value", 7).map((value) => Math.round(value / 100)),
      goal: Math.round(stepGoal / 100),
      unit: "score",
    },
  };

  const monthlyTrendData = {
    steps: {
      key: "steps",
      labels: monthlyStepSeries.slice(-30).map((d, idx) => (idx % 5 === 0 ? String(new Date(`${d.dateTime}T00:00:00`).getDate()) : "")),
      points: getPointsFromSeries(monthlyStepSeries, "value", 30),
      goal: stepGoal,
      unit: "steps",
    },
    sleep: {
      key: "sleep",
      labels: monthSleep.labels.map((label, idx) => (idx % 5 === 0 ? label : "")),
      points: monthSleep.points,
      goal: 7,
      unit: "hrs",
    },
    routine: {
      key: "routine",
      labels: monthlyStepSeries.slice(-30).map((d, idx) => (idx % 5 === 0 ? String(new Date(`${d.dateTime}T00:00:00`).getDate()) : "")),
      points: getPointsFromSeries(monthlyStepSeries, "value", 30).map((value) => Math.min(100, Math.round((value / Math.max(stepGoal, 1)) * 100))),
      goal: 80,
      unit: "%",
    },
    activity: {
      key: "activity",
      labels: monthlyStepSeries.slice(-30).map((d, idx) => (idx % 5 === 0 ? String(new Date(`${d.dateTime}T00:00:00`).getDate()) : "")),
      points: getPointsFromSeries(monthlyStepSeries, "value", 30).map((value) => Math.round(value / 100)),
      goal: Math.round(stepGoal / 100),
      unit: "score",
    },
  };

  const trendData = trendTimeframe === "week" ? weeklyTrendData : monthlyTrendData;

  const setActionLoading = (id, isLoading) => {
    setActionLoadingById((prev) => {
      const next = { ...prev };
      if (isLoading) next[id] = true;
      else delete next[id];
      return next;
    });
  };

  const handleReminderPrimaryAction = async (item) => {
    setActionLoading(item.id, true);
    try {
      if (item.source === "medication") {
        await fetch(`${baseUrl}/api/med/confirm/${item.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, taken: true }),
        });
      } else {
        const endpoint = item.categoryKey === "medications" ? "markTaken" : "complete";
        await fetch(`${baseUrl}/api/reminder/${username}/${item.id}/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
      }
      await fetchAll();
    } catch (error) {
      console.error("Reminder action failed", error);
    } finally {
      setActionLoading(item.id, false);
    }
  };

  const handleReminderSnooze = async (item) => {
    setActionLoading(item.id, true);
    try {
      if (item.source === "medication") {
        await fetch(`${baseUrl}/api/med/confirm/${item.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, taken: false }),
        });
      } else {
        await fetch(`${baseUrl}/api/reminder/${username}/${item.id}/snooze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ snoozeMinutes: 10 }),
        });
      }
      await fetchAll();
    } catch (error) {
      console.error("Reminder snooze failed", error);
    } finally {
      setActionLoading(item.id, false);
    }
  };

  const handleAskTrendsAi = async (question) => {
    const selected = trendData[activeTrendTab] || { points: [], labels: [] };
    setAiLoading(true);
    try {
      const response = await fetch(`${baseUrl}/api/ai/trends-explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metricType: activeTrendTab,
          timeframe: trendTimeframe,
          aggregatedDataPoints: selected.points.map((value, idx) => ({
            label: selected.labels[idx] || String(idx + 1),
            value,
          })),
          userQuestion: question,
        }),
      });
      const data = await response.json();
      setAiAnswer({
        answer: data?.answer || "I can explain this trend after more data is available.",
        confidence: data?.confidence || "Moderate",
        notes: data?.notes || "Based on available dashboard trend data.",
      });
    } catch (error) {
      setAiAnswer({
        answer: "I could not analyze this trend right now.",
        confidence: "Low",
        notes: "Please try again in a moment.",
      });
    } finally {
      setAiLoading(false);
    }
  };

  useEffect(() => {
    if (!weeklyOpen) {
      setAiAnswer(null);
      setAiLoading(false);
    }
  }, [weeklyOpen]);

  if (loading && !summary && !sleepData) {
    return (
      <SmartScreenShell>
        <TopBar timeText={currentTime} title="Today's Overview" showAlexa={false} />
        <p className="ss-helper-text ss-loading-big" role="status" aria-live="polite">
          Loading today's overview...
        </p>
      </SmartScreenShell>
    );
  }

  return (
    <SmartScreenShell>
      <TopBar timeText={currentTime} title="Today's Overview" showAlexa={false} />

      <section className="ss-overview-top-row" aria-label="Insight and reminders">
        <InsightCard
          sleepText={sleepDisplay}
          activityText={activityText}
          suggestionText={suggestionText}
          onAskAi={() => {
            setWeeklyOpen(true);
            setActiveTrendTab("routine");
          }}
        />
        <ReminderIconsPanel
          categories={reminderCategories.slice(0, 5)}
          onOpenCategory={(categoryKey) => {
            setActiveReminderCategory(categoryKey === "more" ? "appointments" : categoryKey);
            setRemindersOpen(true);
          }}
        />
      </section>

      <section className="ss-grid-4" aria-label="Daily metric cards">
        <QuickStatTile
          title="Steps"
          value={steps.toLocaleString()}
          status={stepsStatus.status}
          goalText={`Goal ${stepGoal.toLocaleString()}`}
          progressPercent={pct(steps, stepGoal)}
          progressTone={stepsStatus.tone}
        />
        <QuickStatTile
          title="Sleep"
          value={sleepDisplay}
          status={sleepStatus.status}
          goalText="Goal 7h"
          progressPercent={pct(sleepMinutes, sleepGoalMinutes)}
          progressTone={sleepStatus.tone}
        />
        <QuickStatTile
          title="Distance"
          value={Number(distanceMi).toFixed(1)}
          unit="mi"
          status={distanceStatus.status}
          goalText={`Goal ${distanceGoal} mi`}
          progressPercent={pct(distanceMi, distanceGoal)}
          progressTone={distanceStatus.tone}
        />
        <QuickStatTile
          title="Floors"
          value={String(floors)}
          status={floorsStatus.status}
          goalText={`Goal ${floorGoal}`}
          progressPercent={pct(floors, floorGoal)}
          progressTone={floorsStatus.tone}
        />
      </section>

      <WeeklyTrendsButtonRow onOpen={() => setWeeklyOpen(true)} />

      <RemindersModal
        open={remindersOpen}
        activeCategory={activeReminderCategory}
        onCategoryChange={setActiveReminderCategory}
        categories={reminderCategories.filter((category) => category.key !== "more")}
        reminders={reminderItems}
        onClose={() => setRemindersOpen(false)}
        onPrimaryAction={handleReminderPrimaryAction}
        onSnooze={handleReminderSnooze}
        actionLoading={actionLoadingById}
      />

      <WeeklyTrendsModal
        open={weeklyOpen}
        activeTab={activeTrendTab}
        onTabChange={setActiveTrendTab}
        timeframe={trendTimeframe}
        onTimeframeChange={setTrendTimeframe}
        chartData={trendData}
        onClose={() => setWeeklyOpen(false)}
        onAskAi={handleAskTrendsAi}
        aiLoading={aiLoading}
        aiAnswer={aiAnswer}
      />
    </SmartScreenShell>
  );
};

export default DashboardPage;
