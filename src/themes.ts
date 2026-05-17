/**
 * Crew theme system.
 *
 * Each tab can have a theme. Themes define a name pool, background images,
 * blend/mode settings, and optional colors. Themes can be defined as:
 *   1. A theme.json in ~/.crew/themes/{name}/ (preferred)
 *   2. A theme.json in ~/.wire/themes/{name}/ (legacy path)
 *   3. Hardcoded POOLS fallback (legacy, for themes with no theme.json)
 *
 * When a pane is created without a name, the system picks from the theme's
 * pool, excluding names already in use.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

// --- Theme config type ---

/** RGBA color for iTerm2 profile settings. Components in 0..1 range. */
export type ThemeColor = {
  r: number;
  g: number;
  b: number;
  a?: number;
};

export type ThemeConfig = {
  name: string;
  description?: string;
  author?: string;
  version?: string;
  /** Name pool for auto-naming panes. */
  pool: string[];
  background: {
    /** Opacity blend (0 = invisible, 1 = fully opaque). Default: 0.5 */
    blend: number;
    /** iTerm2 background image mode (0=tile, 1=stretch, 2=scale-to-fill). Default: 2 */
    mode: number;
    /** Map of pane name → image filename (relative to theme dir). "default" key is fallback. */
    images: Record<string, string>;
  };
  /** Optional per-pane badge color overrides. Key = pane name. */
  badgeColors?: Record<string, ThemeColor>;
  /** Optional theme-wide default badge color (used when a pane has no specific override). */
  defaultBadgeColor?: ThemeColor;
};

// --- Theme directories ---

const CREW_THEMES_DIR = join(process.env.HOME ?? "/tmp", ".crew", "themes");
const WIRE_THEMES_DIR = join(process.env.HOME ?? "/tmp", ".wire", "themes");

// --- Legacy pools (fallback when no theme.json exists) ---

const POOLS: Record<string, string[]> = {
  trees: [
    "walnut", "oak", "cherry", "maple", "ash",
    "birch", "elm", "alder", "beech", "hickory",
    "cedar", "pine", "spruce", "fir", "hemlock",
    "teak", "mahogany", "ebony", "rosewood", "bamboo",
  ],
  rivers: [
    "thames", "seine", "danube", "rhine", "tigris",
    "nile", "ganges", "volga", "amazon", "missouri",
    "yukon", "loire", "elbe", "don", "ohio",
    "platte", "snake", "rouge", "pearl", "verde",
  ],
  stones: [
    "granite", "marble", "slate", "basalt", "quartz",
    "obsidian", "flint", "jasper", "onyx", "agate",
    "pumice", "shale", "gneiss", "chalk", "dolomite",
    "travertine", "sandstone", "limestone", "soapstone", "feldspar",
  ],
  peaks: [
    "rainier", "denali", "shasta", "hood", "baker",
    "whitney", "elbert", "olympus", "logan", "robson",
    "fuji", "blanc", "elbrus", "rosa", "matterhorn",
    "cook", "vinson", "kailash", "ararat", "sinai",
  ],
  spices: [
    "saffron", "cardamom", "cumin", "cinnamon", "clove",
    "nutmeg", "ginger", "turmeric", "paprika", "sumac",
    "anise", "fennel", "coriander", "thyme", "oregano",
    "basil", "sage", "tarragon", "dill", "caraway",
  ],
  cities: [
    "rome", "paris", "vienna", "prague", "lisbon",
    "florence", "barcelona", "bruges", "edinburgh", "zurich",
    "boston", "savannah", "havana", "montreal", "lima",
    "cairo", "marrakech", "istanbul", "beirut", "nairobi",
  ],
};

// --- Theme discovery and loading ---

/**
 * Resolve the directory path for a theme.
 * Checks ~/.crew/themes/{name} first, then ~/.wire/themes/{name}.
 * Returns null if neither exists.
 */
export function resolveThemeDir(theme: string): string | null {
  const crewDir = join(CREW_THEMES_DIR, theme);
  if (existsSync(crewDir)) return crewDir;
  const wireDir = join(WIRE_THEMES_DIR, theme);
  if (existsSync(wireDir)) return wireDir;
  return null;
}

/**
 * Load a theme config from disk.
 *
 * Resolution order:
 *   1. ~/.crew/themes/{name}/theme.json
 *   2. ~/.wire/themes/{name}/theme.json
 *   3. Synthesize from legacy structure (image scan + hardcoded pool)
 *
 * Returns null if the theme can't be found at all.
 */
export function loadTheme(theme: string): ThemeConfig | null {
  // Try theme.json in both directories
  for (const base of [CREW_THEMES_DIR, WIRE_THEMES_DIR]) {
    const jsonPath = join(base, theme, "theme.json");
    if (existsSync(jsonPath)) {
      try {
        const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
        return validateTheme(raw, theme);
      } catch (e) {
        console.error(`[crew] failed to parse ${jsonPath}:`, e);
        return null;
      }
    }
  }

  // No theme.json — synthesize from legacy structure
  return synthesizeLegacyTheme(theme);
}

/**
 * Save a theme config to disk as theme.json.
 * Writes to the directory where the theme was loaded from.
 * If the theme doesn't exist on disk yet, writes to ~/.wire/themes/{name}/.
 */
export function saveTheme(config: ThemeConfig): void {
  const dir = resolveThemeDir(config.name) ?? join(WIRE_THEMES_DIR, config.name);
  const jsonPath = join(dir, "theme.json");
  const out: any = {
    name: config.name,
    ...(config.description && { description: config.description }),
    ...(config.author && { author: config.author }),
    ...(config.version && { version: config.version }),
    pool: config.pool,
    background: config.background,
  };
  writeFileSync(jsonPath, JSON.stringify(out, null, 2) + "\n");
}

/**
 * Update specific fields of a theme and save.
 * Returns the updated config.
 */
export function updateTheme(
  theme: string,
  updates: {
    blend?: number;
    mode?: number;
    images?: Record<string, string>;
  },
): ThemeConfig | null {
  const config = loadTheme(theme);
  if (!config) return null;

  if (updates.blend !== undefined) config.background.blend = updates.blend;
  if (updates.mode !== undefined) config.background.mode = updates.mode;
  if (updates.images) {
    config.background.images = { ...config.background.images, ...updates.images };
  }

  saveTheme(config);
  return config;
}

/**
 * Validate and normalize a raw theme.json object.
 *
 * Accepts two shapes for back-compat:
 *   1. Nested:  { background: { blend, mode, images }, badgeColors, ... }
 *   2. Flat:    { blend, mode, images, badgeColors, ... }  ← crew-theme-peaks shipped this
 * Top-level fields win when both are present.
 */
function validateTheme(raw: any, fallbackName: string): ThemeConfig {
  const name = raw.name ?? fallbackName;
  const pool = Array.isArray(raw.pool) ? raw.pool : (POOLS[name] ?? []);
  const bg = raw.background ?? {};

  const blend =
    typeof raw.blend === "number" ? raw.blend
    : typeof bg.blend === "number" ? bg.blend
    : 0.5;
  const mode =
    typeof raw.mode === "number" ? raw.mode
    : typeof bg.mode === "number" ? bg.mode
    : 2;
  const images =
    (typeof raw.images === "object" && raw.images !== null) ? raw.images
    : (typeof bg.images === "object" && bg.images !== null) ? bg.images
    : {};

  return {
    name,
    description: raw.description,
    author: raw.author,
    version: raw.version,
    pool,
    background: { blend, mode, images },
    badgeColors: raw.badgeColors ?? bg.badgeColors,
    defaultBadgeColor: raw.defaultBadgeColor ?? bg.defaultBadgeColor,
  };
}

/**
 * Synthesize a ThemeConfig from a legacy theme directory (no theme.json).
 * Scans for image files and maps them to pane names by filename.
 * Returns null if no directory or pool exists.
 */
function synthesizeLegacyTheme(theme: string): ThemeConfig | null {
  const dir = resolveThemeDir(theme);
  const pool = POOLS[theme];
  if (!dir && !pool) return null;

  // Scan images from directory
  const images: Record<string, string> = {};
  if (dir) {
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        const match = file.match(/^(.+)\.(jpg|jpeg|png|webp)$/i);
        if (match) {
          images[match[1].toLowerCase()] = file;
        }
      }
    } catch {
      // Directory unreadable — continue with empty images
    }
  }

  return {
    name: theme,
    pool: pool ?? [],
    background: {
      blend: 0.5,
      mode: 2,
      images,
    },
  };
}

/**
 * List all available theme names.
 * Combines themes discovered on disk with legacy hardcoded pools.
 */
export function listThemes(): string[] {
  const names = new Set(Object.keys(POOLS));

  for (const base of [CREW_THEMES_DIR, WIRE_THEMES_DIR]) {
    if (!existsSync(base)) continue;
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch {
      // Directory unreadable
    }
  }

  return [...names].sort();
}

/** All available theme names (computed). */
export const THEME_NAMES = Object.keys(POOLS);

/**
 * Pick an unused name from a theme's pool.
 * Loads pool from theme.json if available, falls back to hardcoded POOLS.
 * Returns null if the theme is unknown or the pool is exhausted.
 */
export function pickName(theme: string, usedNames: string[]): string | null {
  const config = loadTheme(theme);
  const pool = config?.pool ?? POOLS[theme];
  if (!pool) return null;
  const used = new Set(usedNames);
  const available = pool.filter((n) => !used.has(n));
  if (available.length === 0) return null;
  return available[0];
}

/**
 * Check if a theme name is valid.
 */
export function isValidTheme(theme: string): boolean {
  return theme in POOLS || resolveThemeDir(theme) !== null;
}

/**
 * Resolve background image path for a themed pane.
 * Uses theme config's image map first, then falls back to file scan.
 * Returns null if no image is found.
 */
export function backgroundImagePath(theme: string, name: string, config?: ThemeConfig | null): string | null {
  const dir = resolveThemeDir(theme);
  if (!dir) return null;

  // Use config's image map if available
  const cfg = config ?? loadTheme(theme);
  if (cfg?.background.images) {
    const filename = cfg.background.images[name] ?? cfg.background.images["default"];
    if (filename) {
      const path = join(dir, filename);
      if (existsSync(path)) return path;
    }
  }

  // Fallback: scan for {name}.{ext}
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const path = join(dir, `${name}.${ext}`);
    if (existsSync(path)) return path;
  }
  return null;
}
