"use strict";

const ANSI = {
  reset: "\u001b[0m", bold: "\u001b[1m", dim: "\u001b[2m",
  cyan: "\u001b[36m", green: "\u001b[32m", yellow: "\u001b[33m", red: "\u001b[31m",
};

function colorEnabled(stream = process.stdout, env = process.env) {
  if (Object.hasOwn(env, "NO_COLOR") || env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR) return true;
  return Boolean(stream?.isTTY);
}

function paint(value, tone, enabled = colorEnabled()) {
  return enabled ? `${ANSI[tone]}${value}${ANSI.reset}` : String(value);
}

function link(url, label = url, stream = process.stdout, env = process.env) {
  if (!stream?.isTTY || env.TERM === "dumb" || Object.hasOwn(env, "NO_HYPERLINK")) return label;
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

function title(name, subtitle = "", options = {}) {
  const enabled = options.color ?? colorEnabled(options.stream, options.env);
  const first = `${paint(name, "bold", enabled)}${subtitle ? ` ${paint(subtitle, "dim", enabled)}` : ""}`;
  return `${first}\n${"═".repeat(58)}`;
}

function section(name, options = {}) {
  const enabled = options.color ?? colorEnabled(options.stream, options.env);
  return paint(String(name).toUpperCase(), "cyan", enabled);
}

function badge(text, tone = "green", options = {}) {
  const enabled = options.color ?? colorEnabled(options.stream, options.env);
  return paint(`[${text}]`, tone, enabled);
}

module.exports = { ANSI, colorEnabled, paint, link, title, section, badge };
