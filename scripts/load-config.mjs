import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

export function loadConfig() {
  let raw = process.env.APP_CONFIG;
  if (raw === undefined) {
    try {
      raw = parseEnv(readFileSync(".env", "utf8")).APP_CONFIG;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (raw === undefined) return;
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("APP_CONFIG must contain valid JSON.");
  }
  if (
    !config ||
    Array.isArray(config) ||
    typeof config !== "object" ||
    Object.entries(config).some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string",
    )
  ) {
    throw new Error(
      "APP_CONFIG must be an object of environment names and string values.",
    );
  }
  Object.assign(process.env, config);
}

loadConfig();
