// Pure argument parsers shared by the qa-browser CLI and daemon.

export function parseTimeArg(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("scrub requires <seconds|mm:ss>");
  const parts = raw.split(":");
  if (parts.length > 3) {
    throw new Error(`Invalid time "${input}" (expected seconds, m:ss, or mm:ss)`);
  }
  if (!parts.every((p) => /^\d+(?:\.\d+)?$/.test(p))) {
    throw new Error(`Invalid time "${input}" (expected seconds, m:ss, or mm:ss)`);
  }
  for (let i = 0; i < parts.length - 1; i++) {
    if (!/^\d+$/.test(parts[i])) {
      throw new Error(`Invalid time "${input}" (minutes must be whole numbers)`);
    }
  }
  if (parts.length === 1) return Number(parts[0]);
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

export function parseCoordinate(value, label = "coordinate") {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${label} must be a finite number (got "${value}")`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${label} must be a finite number (got "${value}")`);
  }
  return n;
}

export function parseOnOff(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  throw new Error(`Expected on|off (got "${value}")`);
}
