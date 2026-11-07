/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

export interface SortableModel {
  id?: string;
  name?: string;
  label?: string;
}

const KNOWN_MODEL_OVERRIDES: Record<string, { family: string; version: number; tier: number; effort: number }> = {
  "gemini-3-flash-agent": { family: "gemini", version: 3.5, tier: 40, effort: 20 },
  "gemini-3.5-flash-low": { family: "gemini", version: 3.5, tier: 40, effort: 30 },
  "gemini-3.5-flash-extra-low": { family: "gemini", version: 3.5, tier: 40, effort: 50 },
  "gemini-pro-agent": { family: "gemini", version: 3.1, tier: 20, effort: 20 },
};

const VENDOR_PRIORITY: Record<string, number> = {
  claude: 10,
  gemini: 20,
  gpt: 30,
  openai: 30,
  grok: 40,
  deepseek: 50,
  qwen: 60,
  kimi: 70,
  glm: 80,
  minimax: 90,
  llama: 100,
  mistral: 110,
  codestral: 112,
  devstral: 114,
  nemotron: 120,
  gemma: 130,
  phi: 140,
  "gpt-oss": 200,
  other: 300,
  tab: 900,
  embed: 950,
};

interface ParsedModelRank {
  /** 0 = non-model quota window (Session / Weekly), 1 = standard LLM, 2 = secondary/OSS, 3 = utility/tab/embed */
  category: number;
  windowOrder: number;
  family: string;
  vendorPriority: number;
  /** Major.minor generation (e.g. 5.5, 4.8, 3.8, 2.5) — higher is better/newer. */
  version: number;
  /** Capability tier within the same family + version — lower is better (e.g. Opus=10 < Sonnet=20 < Haiku=30). */
  tier: number;
  /** Reasoning / effort variant within the same tier — lower is better (Max=10 < High=20 < Thinking/Base=30 < Medium=40 < Low=50). */
  effort: number;
  /** Parameter size in billions when present (e.g. 235 > 120 > 70 > 32) — higher is better. */
  paramB: number;
  /** 0 = canonical alias, 1 = preview/experimental, 2 = dated snapshot (e.g. 20251001). */
  snapshotPenalty: number;
  /** Date snapshot (e.g. 20251101) — newer date first among dated snapshots. */
  snapshotDate: number;
  cleanLabel: string;
  rawKey: string;
}

function detectQuotaWindow(text: string): number | undefined {
  const lower = text.trim().toLowerCase();
  if (/^session\b/.test(lower)) return 1;
  if (/^weekly\s*\(/.test(lower) || lower === "weekly") return 2;
  if (/^weekly\b/.test(lower)) return 3;
  if (/^(daily|monthly)\b/.test(lower)) return 4;
  return undefined;
}

function detectFamily(idLower: string, labelLower: string): string {
  const combined = `${idLower} ${labelLower}`;
  if (/^(tab[_-]|autocomplete)/i.test(idLower) || /\btab[_\s-]*(?:jump[_\s-]*)?flash/i.test(combined)) return "tab";
  if (/\bembed(?:ding)?\b/i.test(combined)) return "embed";
  if (/\bgpt[-_\s]*oss\b/i.test(combined)) return "gpt-oss";
  if (/\b(?:claude|anthropic|fable|opus|sonnet|haiku)\b/i.test(combined)) return "claude";
  if (/\bgemini\b/i.test(combined)) return "gemini";
  if (/\b(?:gpt|chatgpt|codex|o[134](?:[-_\s]|$))\b/i.test(combined)) return "gpt";
  if (/\bgrok\b/i.test(combined)) return "grok";
  if (/\bdeepseek\b/i.test(combined)) return "deepseek";
  if (/\b(?:qwen|qwq)\b/i.test(combined)) return "qwen";
  if (/\b(?:kimi|moonshot)\b/i.test(combined)) return "kimi";
  if (/\b(?:glm|chatglm)\b/i.test(combined)) return "glm";
  if (/\bminimax\b/i.test(combined)) return "minimax";
  if (/\bllama\b/i.test(combined)) return "llama";
  if (/\bcodestral\b/i.test(combined)) return "codestral";
  if (/\bdevstral\b/i.test(combined)) return "devstral";
  if (/\b(?:mistral|mixtral|ministral|pixtral|magistral)\b/i.test(combined)) return "mistral";
  if (/\bnemotron\b/i.test(combined)) return "nemotron";
  if (/\bgemma\b/i.test(combined)) return "gemma";
  if (/\bphi[-_\s]*\d/i.test(combined)) return "phi";
  return "other";
}

function extractVersion(family: string, idLower: string, labelLower: string): number {
  const normId = idLower.replace(/\b20\d{6}\b/g, "").replace(/(\d)-(\d)(?!\d)/g, "$1.$2");
  const normLabel = labelLower.replace(/\b20\d{4,6}\b/g, "").replace(/(\d)-(\d)(?!\d)/g, "$1.$2");

  const matchVersion = (source: string, patterns: RegExp[]): number | undefined => {
    for (const pattern of patterns) {
      const m = pattern.exec(source);
      if (m?.[1]) {
        const v = Number.parseFloat(m[1]);
        if (Number.isFinite(v)) return v;
      }
    }
    return undefined;
  };

  if (family === "claude") {
    const patterns = [
      /\b(?:claude|fable|opus|sonnet|haiku)[-_\s]*(\d+(?:\.\d+)?)/i,
      /\b(\d+(?:\.\d+)?)[-_\s]*(?:fable|opus|sonnet|haiku)\b/i,
    ];
    return matchVersion(normLabel, patterns) ?? matchVersion(normId, patterns) ?? 0;
  }

  if (family === "gemini") {
    const patterns = [/\bgemini[-_\s]*(\d+(?:\.\d+)?)/i];
    return matchVersion(normLabel, patterns) ?? matchVersion(normId, patterns) ?? 0;
  }

  if (family === "gpt") {
    const oMatch = /\bo([134])(?:[-_\s]|$)/i.exec(normId) ?? /\bo([134])(?:[-_\s]|$)/i.exec(normLabel);
    if (oMatch) return 4 + Number(oMatch[1]) * 0.1; // o4 -> 4.4, o3 -> 4.3, o1 -> 4.1
    if (/\bgpt[-_\s]*4o\b/i.test(normId) || /\bgpt[-_\s]*4o\b/i.test(normLabel)) return 4.05;
    const patterns = [/\bgpt[-_\s]*(\d+(?:\.\d+)?)/i, /\bcodex[-_\s]*(\d+(?:\.\d+)?)/i];
    return matchVersion(normLabel, patterns) ?? matchVersion(normId, patterns) ?? 0;
  }

  if (family === "kimi") {
    const patterns = [/\bk(\d+(?:\.\d+)?)/i, /\bkimi[-_\s]*(\d+(?:\.\d+)?)/i];
    return matchVersion(normLabel, patterns) ?? matchVersion(normId, patterns) ?? 0;
  }

  if (family === "minimax") {
    const patterns = [/\bm(\d+(?:\.\d+)?)/i, /\bminimax[-_\s]*(\d+(?:\.\d+)?)/i];
    return matchVersion(normLabel, patterns) ?? matchVersion(normId, patterns) ?? 0;
  }

  if (family === "deepseek") {
    if (/\br1\b/i.test(normId) || /\br1\b/i.test(normLabel)) return 3.5;
    const patterns = [/\bv(\d+(?:\.\d+)?)/i, /\bdeepseek[-_\s]*(\d+(?:\.\d+)?)/i];
    return matchVersion(normLabel, patterns) ?? matchVersion(normId, patterns) ?? 3.0;
  }

  const generic = [
    new RegExp(`\\b${family.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}[-_\\s]*v?(\\d+(?:\\.\\d+)?)`, "i"),
    /\bv?(\d+(?:\.\d+)?)(?=[-_\s]|$)/i,
  ];
  return matchVersion(normLabel, generic) ?? matchVersion(normId, generic) ?? 0;
}

function extractTier(family: string, idLower: string, labelLower: string): number {
  const combined = `${idLower} ${labelLower}`;

  if (family === "claude") {
    if (/\bfable\b/i.test(combined)) return 5;
    if (/\bopus\b/i.test(combined)) return 10;
    if (/\bsonnet\b/i.test(combined)) return 20;
    if (/\bhaiku\b/i.test(combined)) return 30;
    return 25;
  }

  if (family === "gemini") {
    if (/\bultra\b/i.test(combined)) return 10;
    if (/\bargon\b/i.test(combined)) return 15;
    if (/\bpro\b/i.test(combined)) return 20;
    if (/\bflash\b/i.test(combined)) {
      if (/\blite\b/i.test(combined)) return 60;
      if (/\bimage\b/i.test(combined)) return 50;
      if (/\bthinking\b/i.test(combined)) return 35;
      return 40;
    }
    if (/\bnano\b/i.test(combined)) return 70;
    return 45;
  }

  if (family === "gpt") {
    if (/\bsol\b/i.test(combined)) return 10;
    if (/\bluna\b/i.test(combined)) return 12;
    if (/\bterra\b/i.test(combined)) return 14;
    if (/\bastra\b/i.test(combined)) return 16;
    if (/\bpro\b/i.test(combined)) return 18;
    if (/\bcodex[-_\s]*max\b/i.test(combined)) return 22;
    if (/\bcodex\b/i.test(combined) && !/\bmini\b/i.test(combined)) return 25;
    if (/\bcodex[-_\s]*mini\b/i.test(combined)) return 45;
    if (/\bmini\b/i.test(combined)) return 50;
    if (/\bnano\b/i.test(combined)) return 60;
    return 20;
  }

  if (/\b(?:max|ultra|opus)\b/i.test(combined)) return 10;
  if (/\b(?:pro|plus|sonnet|reasoner|thinking)\b/i.test(combined) && !/\b(?:flash|mini|lite)\b/i.test(combined)) return 20;
  if (/\bcoder\b/i.test(combined) && !/\b(?:flash|mini|lite)\b/i.test(combined)) return 25;
  if (/\b(?:flashx)\b/i.test(combined)) return 38;
  if (/\b(?:flash|turbo)\b/i.test(combined) && !/\blite\b/i.test(combined)) return 40;
  if (/\b(?:mini|haiku|small)\b/i.test(combined)) return 50;
  if (/\b(?:lite|nano|fast|air)\b/i.test(combined)) return 60;
  return 30;
}

function extractEffort(idLower: string, labelLower: string): number {
  const combined = `${idLower} ${labelLower}`;
  if (/\b(?:xhigh|extra[-_\s]*high|max)\b/i.test(combined) && !/\b(?:minimax|qwen\S*max|codex[-_\s]*max)\b/i.test(combined)) return 10;
  if (/\bhigh\b|\(high\)/i.test(combined)) return 20;
  if (/\bthinking\b|\(thinking\)/i.test(combined)) return 25;
  if (/\bmedium\b|\(medium\)/i.test(combined)) return 30;
  if (/\bextra[-_\s]*low\b|\(extra[-_\s]*low\)/i.test(combined)) return 55;
  if (/\b(?:low|minimal)\b|\(low\)/i.test(combined)) return 50;
  if (/\btiered\b/i.test(combined)) return 60;
  return 35;
}

function extractParamBillions(idLower: string, labelLower: string): number {
  const combined = `${idLower} ${labelLower}`;
  const m = /\b(\d+(?:\.\d+)?)b\b/i.exec(combined);
  return m ? Number.parseFloat(m[1]) : 0;
}

export function parseModelRank(item: string | SortableModel): ParsedModelRank {
  const rawId = typeof item === "string" ? item : (item.id ?? item.label ?? item.name ?? "");
  const rawLabel = typeof item === "string" ? item : (item.name ?? item.label ?? item.id ?? "");
  const idTrim = rawId.trim();
  const labelTrim = rawLabel.trim() || idTrim;
  const idLower = idTrim.toLowerCase();
  const labelLower = labelTrim.toLowerCase();

  const windowOrder = detectQuotaWindow(labelTrim) ?? detectQuotaWindow(idTrim);
  if (windowOrder !== undefined) {
    return {
      category: 0,
      windowOrder,
      family: "window",
      vendorPriority: 0,
      version: 0,
      tier: extractTier("claude", idLower, labelLower),
      effort: 0,
      paramB: 0,
      snapshotPenalty: 0,
      snapshotDate: 0,
      cleanLabel: labelLower,
      rawKey: idLower,
    };
  }

  const override = KNOWN_MODEL_OVERRIDES[idLower];
  const family = override?.family ?? detectFamily(idLower, labelLower);
  const vendorPriority = VENDOR_PRIORITY[family] ?? VENDOR_PRIORITY.other;
  const category = family === "tab" || family === "embed" ? 3 : family === "gpt-oss" || family === "other" ? 2 : 1;
  const version = override?.version ?? extractVersion(family, idLower, labelLower);
  const tier = override?.tier ?? extractTier(family, idLower, labelLower);
  const effort = override?.effort ?? extractEffort(idLower, labelLower);
  const paramB = extractParamBillions(idLower, labelLower);

  const dateMatch = /\b(20\d{6})\b/.exec(idLower) ?? /\b(20\d{2})[-_](\d{2})[-_](\d{2})\b/.exec(labelLower);
  const snapshotDate = dateMatch
    ? Number(dateMatch[1].length === 8 ? dateMatch[1] : `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}`)
    : 0;
  const isPreview = /\b(?:preview|exp|experimental|beta)\b/i.test(`${idLower} ${labelLower}`);
  const snapshotPenalty = snapshotDate > 0 ? 2 : isPreview ? 1 : 0;

  return {
    category,
    windowOrder: 0,
    family,
    vendorPriority,
    version,
    tier,
    effort,
    paramB,
    snapshotPenalty,
    snapshotDate,
    cleanLabel: labelLower,
    rawKey: idLower,
  };
}

/**
 * Deterministic best-to-worst comparator for models across Usage & Quota and Models tabs.
 *
 * - Keeps same-family & same-generation models together (e.g. Claude 5.5 -> Opus 5.5, Sonnet 5.5, Haiku 5.5).
 * - Orders variants within the same tier from highest capability to lowest (High -> base/Thinking -> Medium -> Low -> Tiered).
 * - Orders generations newest/best to oldest (e.g. 5.5 -> 5.1 -> 5 -> 4.8 -> 4.7 -> 4.6 -> 4.5, and 4 -> 3.8 -> 3.5 -> 3.1 -> 3 -> 2.5).
 * - Breaks ties deterministically so refresh never causes model positions to jump.
 */
export function compareModels(a: string | SortableModel, b: string | SortableModel): number {
  const ra = parseModelRank(a);
  const rb = parseModelRank(b);

  if (ra.category !== rb.category) return ra.category - rb.category;
  if (ra.category === 0) {
    if (ra.windowOrder !== rb.windowOrder) return ra.windowOrder - rb.windowOrder;
    if (ra.tier !== rb.tier) return ra.tier - rb.tier;
    return ra.cleanLabel.localeCompare(rb.cleanLabel);
  }

  if (ra.vendorPriority !== rb.vendorPriority) return ra.vendorPriority - rb.vendorPriority;
  if (ra.family !== rb.family) return ra.family.localeCompare(rb.family);
  if (ra.version !== rb.version) return rb.version - ra.version;
  if (ra.tier !== rb.tier) return ra.tier - rb.tier;
  if (ra.paramB !== rb.paramB) return rb.paramB - ra.paramB;
  if (ra.effort !== rb.effort) return ra.effort - rb.effort;
  if (ra.snapshotPenalty !== rb.snapshotPenalty) return ra.snapshotPenalty - rb.snapshotPenalty;
  if (ra.snapshotDate !== rb.snapshotDate) return rb.snapshotDate - ra.snapshotDate;

  const labelCmp = ra.cleanLabel.localeCompare(rb.cleanLabel, undefined, { numeric: true, sensitivity: "base" });
  if (labelCmp !== 0) return labelCmp;
  return ra.rawKey.localeCompare(rb.rawKey, undefined, { numeric: true, sensitivity: "base" });
}

export function sortModels<T extends string | SortableModel>(items: readonly T[]): T[] {
  return [...items].sort(compareModels);
}
