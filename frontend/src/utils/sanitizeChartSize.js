const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const parsePx = (value) => {
  if (value == null) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

export const sanitizeChartSize = (componentData, policy = "container-fit") => {
  const data = componentData?.data && typeof componentData.data === "object" ? componentData.data : componentData;
  const rawHeight = data?.height ?? componentData?.height;
  const heightPx = parsePx(rawHeight);

  if (policy !== "container-fit") {
    return {
      heightPx: heightPx ?? 320,
      cardStyle: {
        width: componentData?.width || data?.width || "100%",
      },
      cleanedOptions: data?.options && typeof data.options === "object" ? { ...data.options } : {},
    };
  }

  const safeHeight = clamp(heightPx ?? 320, 240, 420);
  const rawOptions = data?.options && typeof data.options === "object" ? data.options : {};
  const cleanedOptions = { ...rawOptions };
  delete cleanedOptions.width;
  delete cleanedOptions.minWidth;
  delete cleanedOptions.maxWidth;
  delete cleanedOptions.height;
  delete cleanedOptions.minHeight;
  delete cleanedOptions.maxHeight;

  return {
    heightPx: safeHeight,
    cardStyle: { width: "100%", minWidth: 0, maxWidth: "100%" },
    cleanedOptions,
  };
};

