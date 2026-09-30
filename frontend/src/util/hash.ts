/**
 * Client-side fingerprint matching the backend's electrical_fingerprint.
 * Backend: SHA-256 of json.dumps(payload, sort_keys=True, separators=(",",":"))
 * where payload comes from pydantic model_dump(by_alias=True).
 *
 * JSON number text differs between engines (JS prints 0.000001, Python prints
 * 1e-06), so numbers are re-emitted in Python float-repr style; both engines
 * already produce the same shortest round-trip *digits*, only the notation
 * threshold differs.
 */

function pythonFloat(n: number): string {
  if (Number.isNaN(n) || !Number.isFinite(n)) return "null";
  if (Object.is(n, -0)) return "-0.0";
  if (n === 0) return "0.0";

  // shortest digits + leading-digit exponent from V8's shortest repr
  const raw = Math.abs(n).toString();
  let mantissa: string;
  let intLen: number;
  let engExp = 0;
  if (raw.includes("e")) {
    const [m, ex] = raw.split("e");
    mantissa = m.replace(".", "");
    intLen = m.includes(".") ? m.indexOf(".") : m.length;
    engExp = Number(ex);
  } else {
    mantissa = raw.replace(".", "");
    intLen = raw.includes(".") ? raw.indexOf(".") : raw.length;
  }
  const digits = mantissa.replace(/^0+/, "").replace(/0+$/, "") || "0";
  const leadInMantissa = mantissa.length - mantissa.replace(/^0+/, "").length;
  const e = engExp + intLen - 1 - leadInMantissa;

  const sign = n < 0 ? "-" : "";
  let out: string;
  if (e >= -4 && e < 16) {
    // fixed notation
    if (e >= 0) {
      const intDigits = digits.slice(0, e + 1).padEnd(e + 1, "0");
      const frac = digits.slice(e + 1);
      out = frac ? `${intDigits}.${frac}` : `${intDigits}.0`;
    } else {
      out = `0.${"0".repeat(-e - 1)}${digits}`;
    }
  } else {
    const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0];
    const expSign = e < 0 ? "-" : "+";
    const expNum = Math.abs(e).toString().padStart(2, "0");
    out = `${head}e${expSign}${expNum}`;
  }
  return sign + out;
}

// Fields the backend types as int (everything else numeric is float).
const INT_FIELDS = new Set(["version", "points_per_decade"]);

function canonical(value: unknown, key = ""): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    return INT_FIELDS.has(key) ? String(Math.trunc(value)) : pythonFloat(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v, key)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined && obj[k] !== null)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k], k)}`).join(",")}}`;
}

export async function electricalHash(apiCircuit: unknown): Promise<string> {
  const blob = new TextEncoder().encode(canonical(apiCircuit));
  const digest = await crypto.subtle.digest("SHA-256", blob);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export const __test__ = { canonical, pythonFloat };
