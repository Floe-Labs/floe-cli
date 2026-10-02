// src/services/ext-gateway/csv.ts
var CsvSyntaxError = class extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
};
var CsvTokenizer = class {
  constructor() {
    this.values = [];
    this.cell = "";
    this.quoted = false;
    this.afterQuote = false;
    /** A quote seen inside a quoted field: an escaped quote if the next is one too, else the close. */
    this.pendingQuote = false;
    /** A CR that ended a record: a following LF belongs to it. */
    this.pendingCR = false;
    this.line = 1;
    this.startLine = 1;
  }
  take() {
    this.values.push(this.cell);
    const out = this.values.length === 1 && this.values[0] === "" ? null : { line: this.startLine, values: this.values };
    this.values = [];
    this.cell = "";
    this.afterQuote = false;
    return out;
  }
  *feed(text) {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (ch === '"') {
          this.cell += '"';
          continue;
        }
        this.quoted = false;
        this.afterQuote = true;
      }
      if (this.pendingCR) {
        this.pendingCR = false;
        if (ch === "\n") continue;
      }
      if (this.quoted) {
        if (ch === '"') {
          this.pendingQuote = true;
          continue;
        }
        if (ch === "\n") this.line += 1;
        this.cell += ch;
        continue;
      }
      if (ch === ",") {
        this.values.push(this.cell);
        this.cell = "";
        this.afterQuote = false;
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        const rec = this.take();
        if (rec) yield rec;
        this.line += 1;
        this.startLine = this.line;
        this.pendingCR = ch === "\r";
        continue;
      }
      if (this.afterQuote) throw new CsvSyntaxError(this.line, "characters after a closing quote");
      if (ch === '"') {
        if (this.cell !== "") throw new CsvSyntaxError(this.line, "a quote inside an unquoted field");
        this.quoted = true;
        continue;
      }
      this.cell += ch;
    }
  }
  *finish() {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.quoted = false;
      this.afterQuote = true;
    }
    if (this.quoted) throw new CsvSyntaxError(this.startLine, "unterminated quoted field");
    if (this.cell !== "" || this.values.length > 0 || this.afterQuote) {
      const rec = this.take();
      if (rec) yield rec;
    }
  }
};
async function* streamCsv(chunks) {
  const t = new CsvTokenizer();
  for await (const c of chunks) yield* t.feed(c);
  yield* t.finish();
}

// src/services/ext-gateway/json-exact.ts
var JsonNumber = class {
  constructor(text) {
    this.text = text;
  }
};
var JsonSyntaxError = class extends Error {
};
var NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
var MAX_DEPTH = 64;
var Parser = class {
  constructor(s) {
    this.s = s;
    this.i = 0;
  }
  fail(what) {
    throw new JsonSyntaxError(`${what} at position ${this.i}`);
  }
  ws() {
    while (this.i < this.s.length && " 	\n\r".includes(this.s[this.i])) this.i += 1;
  }
  value(depth) {
    if (depth > MAX_DEPTH) this.fail("nesting too deep");
    this.ws();
    const ch = this.s[this.i];
    if (ch === "{") return this.object(depth);
    if (ch === "[") return this.array(depth);
    if (ch === '"') return this.string();
    for (const [lit, v] of [["true", true], ["false", false], ["null", null]]) {
      if (this.s.startsWith(lit, this.i)) {
        this.i += lit.length;
        return v;
      }
    }
    NUMBER_RE.lastIndex = this.i;
    const m = NUMBER_RE.exec(this.s);
    if (!m) this.fail("unexpected token");
    this.i += m[0].length;
    return new JsonNumber(m[0]);
  }
  object(depth) {
    const out = /* @__PURE__ */ Object.create(null);
    this.i += 1;
    this.ws();
    if (this.s[this.i] === "}") {
      this.i += 1;
      return out;
    }
    for (; ; ) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail("expected a key");
      const k = this.string();
      this.ws();
      if (this.s[this.i] !== ":") this.fail('expected ":"');
      this.i += 1;
      out[k] = this.value(depth + 1);
      this.ws();
      const c = this.s[this.i];
      this.i += 1;
      if (c === "}") return out;
      if (c !== ",") this.fail('expected "," or "}"');
    }
  }
  array(depth) {
    const out = [];
    this.i += 1;
    this.ws();
    if (this.s[this.i] === "]") {
      this.i += 1;
      return out;
    }
    for (; ; ) {
      out.push(this.value(depth + 1));
      this.ws();
      const c = this.s[this.i];
      this.i += 1;
      if (c === "]") return out;
      if (c !== ",") this.fail('expected "," or "]"');
    }
  }
  string() {
    const start = this.i;
    this.i += 1;
    for (; ; ) {
      const c = this.s[this.i];
      if (c === void 0) this.fail("unterminated string");
      if (c === '"') break;
      if (c === "\\") this.i += 1;
      else if (c < " ") this.fail("control character in string");
      this.i += 1;
    }
    this.i += 1;
    try {
      return JSON.parse(this.s.slice(start, this.i));
    } catch {
      return this.fail("bad escape in string");
    }
  }
};
function parseJsonExact(text) {
  const p = new Parser(text);
  const v = p.value(0);
  p.ws();
  if (p.i !== text.length) p.fail("trailing characters");
  return v;
}
var isJsonObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof JsonNumber);

// src/services/ext-gateway/contract.ts
var CONTRACT_VERSIONS = [3];
var CONTRACT_TEMPLATES = { ndjson: "floe-canonical-ndjson@3", csv: "floe-canonical-csv@1" };
var CONTRACT_V3_FIELDS = [
  { name: "id", kind: "text", required: true, synonyms: [], maxLength: 512, description: "The gateway's request id: the idempotency key. Required when the file carries ids; a file with none gets derived ids and its import declares a window." },
  { name: "occurred_at", kind: "instant", required: true, synonyms: ["timestamp"], description: "When the request happened: ISO 8601 with T, seconds, and Z or a \xB1HH:MM offset." },
  { name: "model", kind: "text", required: true, synonyms: [], maxLength: 256, description: "The model as the gateway names it. `provider/model` also names the provider when `provider` is absent." },
  { name: "provider", kind: "text", required: false, synonyms: [], maxLength: 128, description: "Who served it (lowercased). Optional when model reads `provider/model`; a row with neither is refused." },
  { name: "cost", kind: "decimal", required: true, synonyms: ["estimated_cost"], maxLength: 64, description: "USD as the gateway computed it, not as billed: a decimal string. Graded D." },
  { name: "person", kind: "text", required: false, synonyms: ["user"], maxLength: 512, description: "The user: an email or an id (stored only as a pseudonymous person id)." },
  { name: "api_key", kind: "text", required: false, synonyms: [], maxLength: 512, description: "The key's alias or hash." },
  { name: "input_tokens", kind: "integer", required: false, synonyms: ["prompt_tokens"], description: "Input tokens: a non-negative integer." },
  { name: "output_tokens", kind: "integer", required: false, synonyms: ["completion_tokens"], description: "Output tokens: a non-negative integer." },
  { name: "task", kind: "text", required: false, synonyms: [], maxLength: 256, description: "Attribution; part of the slot only when the connection grain names it." },
  { name: "campaign", kind: "text", required: false, synonyms: [], maxLength: 256, description: "Attribution; part of the slot only when the connection grain names it." },
  { name: "customer", kind: "text", required: false, synonyms: [], maxLength: 256, description: "Attribution; part of the slot only when the connection grain names it." },
  { name: "billed_by", kind: "text", required: false, synonyms: [], maxLength: 128, description: "Who bills the traffic; defaults to the provider. Never earns grade B on its own." },
  { name: "cache_hit", kind: "boolean", required: false, synonyms: [], description: "The gateway answered from its cache (a true zero). Absent = false." }
];
var DECIMAL_RE = /^[0-9]+(\.[0-9]+)?$/;
var INTEGER_RE = /^[0-9]+$/;
var INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;
var BOOLEAN_RE = /^(true|false)$/i;
var MAX_INTEGER = "9223372036854775807";
function validInstant(text) {
  const m = INSTANT_RE.exec(text);
  if (!m) return false;
  const [y, mo, d, hh, mi, ss] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || hh > 23 || mi > 59 || ss > 59) return false;
  if (m[9] !== void 0 && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}
var INVALID = /* @__PURE__ */ Symbol("invalid");
function present(v) {
  if (v === void 0 || v === null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "boolean" || v instanceof JsonNumber) return v;
  return INVALID;
}
function typed(kind, v) {
  switch (kind) {
    case "text":
      return typeof v === "string";
    case "decimal":
      return typeof v === "string" && DECIMAL_RE.test(v);
    case "instant":
      return typeof v === "string" && validInstant(v);
    case "boolean":
      return typeof v === "boolean" || typeof v === "string" && BOOLEAN_RE.test(v);
    case "integer": {
      const t = v instanceof JsonNumber ? v.text : typeof v === "string" ? v : null;
      if (t === null || !INTEGER_RE.test(t)) return false;
      return BigInt(t) <= BigInt(MAX_INTEGER);
    }
  }
}
var comparable = (kind, v) => v instanceof JsonNumber ? v.text : kind === "boolean" ? String(v).toLowerCase() : String(v);
function checkContractRow(rec, idKeyed) {
  let provider = false;
  let model = null;
  for (const f of CONTRACT_V3_FIELDS) {
    const names = [f.name, ...f.synonyms];
    const found = [];
    for (const n of names) {
      const v = present(rec.get(n));
      if (v === INVALID) return { ok: false, reason: `invalid_${f.name}`, field: n };
      if (v !== null) found.push({ name: n, value: v });
    }
    if (found.length === 0) {
      if (f.required && !(f.name === "id" && !idKeyed)) return { ok: false, reason: `missing_${f.name}`, field: f.name };
      continue;
    }
    if (f.name === "id" && !idKeyed) return { ok: false, reason: "unexpected_id", field: "id" };
    for (const x of found) {
      if (!typed(f.kind, x.value)) return { ok: false, reason: `invalid_${f.name}`, field: x.name };
      if (f.maxLength !== void 0 && typeof x.value === "string" && x.value.length > f.maxLength) return { ok: false, reason: "too_long", field: x.name };
    }
    if (new Set(found.map((x) => comparable(f.kind, x.value))).size > 1) return { ok: false, reason: `conflicting_${f.name}`, field: found[1].name };
    if (f.name === "provider") provider = true;
    if (f.name === "model") model = found[0].value;
  }
  if (provider) return { ok: true, derived: null };
  const cut = model === null ? -1 : model.indexOf("/");
  const p = cut > 0 ? model.slice(0, cut).trim() : "";
  const rest = cut > 0 ? model.slice(cut + 1).trim() : "";
  if (p === "" || rest === "") return { ok: false, reason: "missing_provider", field: "provider" };
  if (p.length > 128) return { ok: false, reason: "too_long", field: "model" };
  return { ok: true, derived: { provider: p.toLowerCase(), model: rest } };
}
async function contractFileHasIds(format, text) {
  if (format === "csv") {
    try {
      for await (const r of streamCsv(text)) return r.values.map((h) => h.replace(/^\uFEFF/, "").trim()).includes("id");
    } catch {
      return true;
    }
    return true;
  }
  let carry = "";
  for await (const chunk of text) {
    carry += chunk;
    const lines2 = carry.split("\n");
    carry = lines2.pop();
    for (const raw of lines2) {
      const line = raw.replace(/^\uFEFF/, "").trim();
      if (line !== "") return firstLineHasId(line);
    }
  }
  const last = carry.replace(/^\uFEFF/, "").trim();
  return last === "" ? true : firstLineHasId(last);
}
function firstLineHasId(line) {
  try {
    const v = parseJsonExact(line);
    return !isJsonObject(v) || Object.prototype.hasOwnProperty.call(v, "id");
  } catch {
    return true;
  }
}
function contractTemplateFile(format) {
  const fields = {};
  for (const f of CONTRACT_V3_FIELDS) if (f.name !== "id" && f.name !== "cost") fields[f.name] = [f.name, ...f.synonyms];
  const cost = CONTRACT_V3_FIELDS.find((f) => f.name === "cost");
  return {
    template: CONTRACT_TEMPLATES[format],
    gateway: "own",
    title: `Floe canonical gateway-export contract v3, ${format === "csv" ? "CSV" : "NDJSON (the reference)"} form`,
    format,
    doc_urls: ["https://github.com/Floe-Labs/floe-monorepo/blob/main/docs/decisions/004-cost-normalizer.md"],
    doc_retrieved_on: "2026-10-02",
    unconfirmed: [],
    id_field: "id",
    fields,
    cost_field: cost.name,
    cost_aliases: [...cost.synonyms],
    cost_semantics: "usd_estimate",
    cost_provenance: "gateway_computed",
    cost_scale: 0,
    timestamp_format: "iso8601",
    billed_by_rule: { kind: "field", field: "provider" },
    default_provider_required: false,
    reject_when_true: [],
    require_equal: [],
    ignore_list: [],
    contract_version: 3
  };
}

// src/services/ext-gateway/errors.ts
var ExtGatewayError = class extends Error {
  constructor(status, code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
    this.name = "ExtGatewayError";
  }
  body() {
    return { error: this.code, detail: this.detail, ...this.extra };
  }
};

// ../../packages/shared/src/ledger/ext-gateway-decimal.ts
var DECIMAL_RE2 = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
var MAX_EXPONENT = 64;
var MAX_TEXT = 128;
function formatScaled({ n, scale }) {
  if (scale <= 0) return (n * 10n ** BigInt(-scale)).toString();
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : whole;
  return neg && out !== "0" ? `-${out}` : out;
}
function parseScaled(raw, shift) {
  if (raw.length > MAX_TEXT) return null;
  const m = DECIMAL_RE2.exec(raw);
  if (!m) return null;
  const frac = m[3] ?? m[4] ?? "";
  const exp = m[5] === void 0 ? 0 : Number(m[5]);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > MAX_EXPONENT) return null;
  const magnitude = BigInt(`${m[2] ?? ""}${frac}` || "0");
  return { n: m[1] === "-" ? -magnitude : magnitude, scale: frac.length - exp - shift };
}
function parseExactDecimal(raw, shift = 0) {
  const s = parseScaled(raw, shift);
  return s === null ? null : formatScaled(s);
}
var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;
var MAX_EPOCH_SECONDS = 253402300800n;
var micros = (frac) => frac.slice(0, 6).padEnd(6, "0");
var isoAt = (ms, frac) => `${new Date(ms).toISOString().slice(0, 19)}.${micros(frac)}Z`;
function parseEpoch(raw) {
  const dec = parseExactDecimal(raw);
  if (dec === null || dec.startsWith("-")) return null;
  const [whole, frac = ""] = dec.split(".");
  const seconds = BigInt(whole);
  if (seconds >= MAX_EPOCH_SECONDS) return null;
  return isoAt(Number(seconds) * 1e3, frac);
}
function offsetMinutes(zone) {
  if (zone === void 0 || zone === "Z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (h * 60 + min);
}
function parseIso(raw, naiveIsUtc) {
  const m = ISO_RE.exec(raw);
  if (!m) return null;
  if (m[8] === void 0 && !naiveIsUtc) return null;
  const [y, mo, d, hh, mi, ss] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || hh > 23 || mi > 59 || ss > 59) return null;
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  const offset = offsetMinutes(m[8]);
  if (offset === null) return null;
  return isoAt(Date.UTC(y, mo - 1, d, hh, mi, ss) - offset * 6e4, m[7] ?? "");
}
function parseGatewayInstant(raw, format) {
  if (format === "epoch_seconds_decimal") return parseEpoch(raw);
  return parseIso(raw, format === "iso8601_utc_naive");
}

// ../../packages/shared/src/ledger/formulas.ts
var FormulaError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FormulaError";
  }
};
var FORMULA_NAME_RE = /^[a-z0-9_]+$/;
var registered = /* @__PURE__ */ new WeakSet();
function createFormulaRegistry() {
  const byId = /* @__PURE__ */ new Map();
  return {
    define(name, version, fn) {
      if (typeof name !== "string" || !FORMULA_NAME_RE.test(name)) {
        throw new FormulaError(`formula name must match ${FORMULA_NAME_RE}: got ${JSON.stringify(name)}`);
      }
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new FormulaError(`formula ${name} needs a positive integer version: got ${JSON.stringify(version)}`);
      }
      if (typeof fn !== "function") throw new FormulaError(`formula ${name}@${version} needs a function`);
      const formulaId = `${name}@${version}`;
      if (byId.has(formulaId)) throw new FormulaError(`formula ${formulaId} is already defined`);
      const formula = Object.freeze({ formulaId, name, version, fn });
      byId.set(formulaId, formula);
      registered.add(formula);
      return formula;
    },
    get: (formulaId) => byId.get(formulaId),
    list: () => [...byId.values()].sort((a, b) => a.formulaId < b.formulaId ? -1 : a.formulaId > b.formulaId ? 1 : 0)
  };
}
var formulaRegistry = createFormulaRegistry();
function defineFormula(name, version, fn) {
  return formulaRegistry.define(name, version, fn);
}
var materializeOnLockFormula = defineFormula("materialize_on_lock", 1, (inputs) => {
  if (inputs.length !== 1) throw new FormulaError(`materialize_on_lock@1 copies exactly one entry, got ${inputs.length}`);
  const [i] = inputs;
  return [{ type: "assumption", metric: i.metric, unit: i.unit, amount: i.amount }];
});

// ../../packages/shared/src/ledger/figure-grades.ts
var PROVENANCE_GRADE = Object.freeze({
  x402_settled_onchain: "A",
  vendor_leg_exact: "A",
  vendor_leg_invoiced: "A",
  plan_invoice_finalized: "A",
  floe_settled: "B",
  x402_pending_settlement: "B",
  vendor_leg_period_rate: "B",
  vendor_uncaptured_residual: "B",
  orchestrator_call_end: "B",
  plan_invoice_draft: "B",
  ext_gateway_billed: "B",
  hold_reserved: "B",
  manual_figure: "C",
  assumption_value: "C",
  handoff_cost: "C",
  confirmed_vendor_rate: "C",
  ledger_sync: "D",
  hold_locked_override: "D",
  list_price_estimate: "D",
  cost_calculator: "D",
  forecast: "D",
  unconfirmed_vendor_rate: "D",
  ext_gateway_estimate: "D",
  floe_catalog: "D",
  vendor_claim: "D"
});

// ../../packages/shared/src/ledger/ext-gateway.ts
var EXT_GATEWAY_COST_PROVENANCES = ["gateway_computed", "vendor_reported"];
var MONEY_PROVENANCE = Object.freeze({
  gateway_computed: "ext_gateway_estimate",
  vendor_reported: "ext_gateway_billed"
});

// src/services/ext-gateway/map-row.ts
var FLOE_GATEWAY_HOSTS = ["credit-api.floelabs.xyz"];
function isFloeGateway(base) {
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `https://${base}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return FLOE_GATEWAY_HOSTS.includes(host.replace(/\.$/, ""));
}
var SKIPPED_ROW_REASONS = /* @__PURE__ */ new Set(["floe_gateway_traffic"]);
var FAILURE_STATUSES = /* @__PURE__ */ new Set(["failure", "failed", "error"]);
var MAX = {
  api_base: 2048,
  id: 512,
  person: 512,
  api_key: 512,
  model: 256,
  provider: 128,
  billed_by: 128,
  task: 256,
  campaign: 256,
  customer: 256
};
var INVALID2 = /* @__PURE__ */ Symbol("invalid");
var MAX_BIGINT = 9223372036854775807n;
function textOf(v) {
  if (v === void 0 || v === null) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (v instanceof JsonNumber) return v.text;
  return INVALID2;
}
var Refused = class extends Error {
  constructor(reason, field) {
    super(reason);
    this.reason = reason;
    this.field = field;
  }
};
function mapRecord(spec, rec) {
  const text = (field2, paths) => {
    for (const p of paths) {
      const t = textOf(rec.get(p));
      if (t === INVALID2) throw new Refused(`invalid_${field2}`, p);
      if (t === null) continue;
      if (t.length > (MAX[field2] ?? 256)) throw new Refused("too_long", p);
      return t;
    }
    return null;
  };
  const field = (f) => text(f, spec.fields[f] ?? []);
  const tokens = (f) => {
    const t = field(f);
    if (t === null) return null;
    const d = parseExactDecimal(t);
    if (d === null || d.startsWith("-") || d.includes(".") || BigInt(d) > MAX_BIGINT) throw new Refused(`invalid_${f}`);
    return d;
  };
  const cacheHit = () => {
    for (const p of spec.fields.cache_hit ?? []) {
      const v = rec.get(p);
      if (v === void 0 || v === null) continue;
      if (typeof v === "boolean") return v;
      if (typeof v === "string") {
        const t = v.trim().toLowerCase();
        if (t === "true") return true;
        if (t === "false" || t === "none" || t === "") continue;
      }
      throw new Refused("invalid_cache_hit", p);
    }
    return false;
  };
  try {
    let derived = null;
    if (spec.contractVersion) {
      const c = checkContractRow(rec, spec.idField !== null);
      if (!c.ok) throw new Refused(c.reason, c.field);
      derived = c.derived;
    }
    for (const g of spec.rejectWhenTrue) {
      const v = rec.get(g.field);
      if (v === true || typeof v === "string" && v.trim().toLowerCase() === "true") throw new Refused(g.reason, g.field);
    }
    for (const g of spec.requireEqual) {
      const t = textOf(rec.get(g.field));
      if (t === null && g.allowMissing === true) continue;
      if (t !== g.value) throw new Refused(g.reason, g.field);
    }
    const base = field("api_base");
    if (base !== null && isFloeGateway(base)) throw new Refused("floe_gateway_traffic", spec.fields.api_base?.[0]);
    const externalId = spec.idField ? text("id", [spec.idField]) : null;
    if (spec.idField && externalId === null) throw new Refused("missing_id", spec.idField);
    const when = field("occurred_at");
    if (when === null) throw new Refused("missing_occurred_at");
    const occurredAt = parseGatewayInstant(when, spec.timestampFormat);
    if (occurredAt === null) throw new Refused("invalid_occurred_at");
    const model = derived?.model ?? field("model");
    if (model === null) throw new Refused("missing_model");
    const provider = (field("provider") ?? derived?.provider ?? spec.defaultProvider)?.toLowerCase() ?? null;
    if (provider === null) throw new Refused("missing_provider");
    const rule = spec.billedByRule;
    const ruled = rule.kind === "constant" ? rule.value : rule.field === "provider" ? provider : field(rule.field);
    const billedBy = (field("billed_by") ?? ruled)?.toLowerCase() ?? null;
    if (billedBy === null) throw new Refused("missing_billed_by");
    let costText = null;
    let costName = spec.costField;
    for (const name of [spec.costField, ...spec.costAliases ?? []]) {
      costText = textOf(rec.get(name));
      costName = name;
      if (costText !== null) break;
    }
    if (costText === null) throw new Refused("missing_cost", spec.costField);
    const cost = costText === INVALID2 ? null : parseExactDecimal(costText, spec.costScale);
    if (cost === null) throw new Refused("invalid_cost", costName);
    if (cost.startsWith("-")) throw new Refused("negative_cost", costName);
    return {
      ok: true,
      row: {
        row: rec.row,
        externalId,
        occurredAt,
        usageDay: occurredAt.slice(0, 10),
        person: field("person"),
        apiKeyRef: field("api_key"),
        model,
        provider,
        billedBy,
        task: field("task"),
        campaign: field("campaign"),
        customer: field("customer"),
        inputTokens: tokens("input_tokens"),
        outputTokens: tokens("output_tokens"),
        cost,
        cacheHit: cacheHit(),
        failed: FAILURE_STATUSES.has((field("status") ?? "").toLowerCase())
      }
    };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason, ...err.field ? { field: err.field } : {} };
    throw err;
  }
}

// src/services/ext-gateway/profile-core.ts
var REQUIRED = ["occurred_at", "model"];
var MONEY = /* @__PURE__ */ new Set([
  "cost",
  "costs",
  "spend",
  "spent",
  "price",
  "prices",
  "pricing",
  "amount",
  "charge",
  "charged",
  "charges",
  "usd",
  "fee",
  "fees",
  "bill",
  "billed",
  "billing",
  "invoice",
  "invoiced",
  "saving",
  "savings",
  "credit",
  "credits",
  "currency",
  "revenue",
  "discount",
  "paid",
  "payment"
]);
var IDENTITY = /* @__PURE__ */ new Set([
  "user",
  "users",
  "username",
  "email",
  "mail",
  "ip",
  "phone",
  "name",
  "key",
  "apikey",
  "alias",
  "customer",
  "account",
  "org",
  "organization",
  "team",
  "owner",
  "person",
  "address"
]);
function looksSensitive(field) {
  const tokens = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((t) => MONEY.has(t) || IDENTITY.has(t) || t.startsWith("cost") || t.endsWith("cost") || t.includes("email"));
}
function knownFields(spec) {
  const top2 = (p) => spec.format === "ndjson" ? p.split(".")[0] : p;
  const out = /* @__PURE__ */ new Set([top2(spec.costField), ...(spec.costAliases ?? []).map(top2)]);
  if (spec.contractVersion) out.add("id");
  if (spec.idField) out.add(top2(spec.idField));
  for (const c of Object.values(spec.fields)) for (const p of c ?? []) out.add(top2(p));
  for (const g of [...spec.rejectWhenTrue, ...spec.requireEqual]) out.add(top2(g.field));
  return out;
}
function checkSpec(spec) {
  const bad = (detail) => ({ ok: false, error: "invalid_profile", detail });
  for (const f of REQUIRED) if (!spec.fields[f]?.length) return bad(`${f} must be mapped.`);
  if (!spec.fields.provider?.length && !spec.defaultProvider) return bad("provider must be mapped, or a defaultProvider declared.");
  if (spec.format === "ndjson" && !spec.idField) return bad("An NDJSON profile needs an idField (the gateway's request id).");
  const rule = spec.billedByRule;
  if (rule.kind === "field" && rule.field !== "provider" && !spec.fields[rule.field]?.length) {
    return bad(`billedBy names ${rule.field}, which is not mapped.`);
  }
  const known = knownFields(spec);
  const seen = /* @__PURE__ */ new Set();
  for (const i of spec.ignoreList) {
    if (seen.has(i.field)) return bad(`${i.field} is ignored twice.`);
    if (known.has(i.field)) return bad(`${i.field} is both read and ignored.`);
    seen.add(i.field);
  }
  const unjustified = spec.ignoreList.filter((i) => looksSensitive(i.field) && !i.justification?.trim()).map((i) => i.field);
  if (unjustified.length > 0) {
    return {
      ok: false,
      error: "justification_required",
      fields: unjustified,
      detail: `Ignoring a money- or identity-looking field needs a justification: ${unjustified.join(", ")}.`
    };
  }
  return { ok: true };
}

// src/services/ext-gateway/source-file.ts
var REQUIRED2 = ["occurred_at", "model", "provider"];
function unmapped(spec, names) {
  const known = knownFields(spec);
  const ignored = new Set(spec.ignoreList.map((i) => i.field));
  const out = [];
  for (const n of names) if (!known.has(n) && !ignored.has(n) && !out.includes(n)) out.push(n);
  return out;
}
function haltUnmapped(fields) {
  if (fields.length === 0) return;
  throw new ExtGatewayError(
    422,
    "unmapped_fields",
    `These fields are neither mapped nor ignored by the profile: ${fields.join(", ")}. Add them to the ignore-list in a new profile version, or map them.`,
    { fields }
  );
}
async function* readCsv(spec, text) {
  try {
    const records = streamCsv(text);
    const first = await records.next();
    const header = first.done ? [] : first.value.values.map((h) => h.trim());
    if (header.length === 0) throw new ExtGatewayError(422, "empty_file", "The file has no header row.");
    const dupes = header.filter((h, i) => header.indexOf(h) !== i);
    if (dupes.length > 0) throw new ExtGatewayError(422, "duplicate_headers", `Repeated headers: ${[...new Set(dupes)].join(", ")}.`, { fields: [...new Set(dupes)] });
    haltUnmapped(unmapped(spec, header));
    const has = new Set(header);
    const missing = [];
    if (spec.idField && !has.has(spec.idField)) missing.push({ field: "id", candidates: [spec.idField] });
    for (const f of REQUIRED2) {
      if (f === "provider" && (spec.defaultProvider || spec.contractVersion)) continue;
      const candidates = spec.fields[f] ?? [];
      if (!candidates.some((c) => has.has(c))) missing.push({ field: f, candidates });
    }
    const costNames = [spec.costField, ...spec.costAliases ?? []];
    if (!costNames.some((c) => has.has(c))) missing.push({ field: "cost", candidates: costNames });
    if (missing.length > 0) {
      throw new ExtGatewayError(422, "missing_fields", `Required columns are missing: ${missing.map((m) => m.field).join(", ")}.`, { fields: missing });
    }
    const index = new Map(header.map((h, i) => [h, i]));
    let row = 0;
    for await (const r of records) {
      row += 1;
      if (r.values.length !== header.length) {
        yield { rejected: { row, reason: "column_count" } };
        continue;
      }
      const values = r.values;
      yield { record: { row, get: (name) => {
        const i = index.get(name);
        return i === void 0 ? void 0 : values[i];
      } } };
    }
    if (row === 0) throw new ExtGatewayError(422, "empty_file", "The file has no rows.");
  } catch (err) {
    if (err instanceof CsvSyntaxError) throw new ExtGatewayError(422, "malformed_csv", err.message, { line: err.line });
    throw err;
  }
}
function walk(obj, path) {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (typeof cur === "string" && cur.trimStart().startsWith("{")) {
      try {
        cur = parseJsonExact(cur);
      } catch {
        return void 0;
      }
    }
    if (!isJsonObject(cur)) return void 0;
    cur = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : void 0;
  }
  return cur;
}
async function* lines(text) {
  let carry = "";
  for await (const chunk of text) {
    const parts = (carry + chunk).split("\n");
    carry = parts.pop();
    yield* parts;
  }
  if (carry !== "") yield carry;
}
async function* readNdjson(spec, text) {
  const keys = /* @__PURE__ */ new Set();
  let row = 0;
  for await (const raw of lines(text)) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    row += 1;
    let v;
    try {
      v = parseJsonExact(line);
    } catch (err) {
      if (!(err instanceof JsonSyntaxError)) throw err;
      yield { rejected: { row, reason: "malformed_json" } };
      continue;
    }
    if (!isJsonObject(v)) {
      yield { rejected: { row, reason: "not_an_object" } };
      continue;
    }
    for (const k of Object.keys(v)) keys.add(k);
    const obj = v;
    yield { record: { row, get: (path) => walk(obj, path) } };
  }
  haltUnmapped(unmapped(spec, keys));
  if (row === 0) throw new ExtGatewayError(422, "empty_file", "The file has no rows.");
}
async function* withoutBom(text) {
  let first = true;
  for await (const c of text) {
    yield first && c.startsWith("\uFEFF") ? c.slice(1) : c;
    first = false;
  }
}
function sourceItems(spec, text) {
  const body = withoutBom(text);
  return spec.format === "csv" ? readCsv(spec, body) : readNdjson(spec, body);
}

// src/services/ext-gateway/profiles/litellm-standard-logging-ndjson.json
var litellm_standard_logging_ndjson_default = {
  template: "litellm-standard-logging-ndjson@3",
  gateway: "litellm",
  title: "LiteLLM proxy: S3/GCS logging callback NDJSON (StandardLoggingPayload, one per line; s3_batch_file_upload batch_*.jsonl)",
  format: "ndjson",
  doc_urls: [
    "https://raw.githubusercontent.com/BerriAI/litellm/c030191be665ec4432c2b66f2f88a5ae67147c2b/litellm/types/utils.py",
    "https://docs.litellm.ai/docs/proxy/logging_spec",
    "https://docs.litellm.ai/docs/proxy/logging"
  ],
  doc_retrieved_on: "2026-10-01",
  version_notes: [
    "@3: status is mapped (no longer ignored): a row LiteLLM logged as a failure is flagged failed, a true zero (never priced, never a gap, still a counted request). CFO N1.",
    "@2: api_base is mapped (no longer ignored): a row whose base is Floe's own gateway (credit-api.floelabs.xyz) is refused, floe_gateway_traffic, because Floe's gateway already metered it (proxy_requests). CFO S5."
  ],
  unconfirmed: [
    "startTime is a float epoch in seconds; it is read as an exact decimal (never through a float) and truncated to microseconds.",
    "response_cost is LiteLLM's list-price or custom-price figure for the request, not the provider's invoice: grade D, billed_by = custom_llm_provider.",
    "The person is the first non-empty of the key owner's email, the key owner's user id, then end_user; a service key with none is no person."
  ],
  id_field: "id",
  fields: {
    occurred_at: [
      "startTime"
    ],
    person: [
      "metadata.user_api_key_user_email",
      "metadata.user_api_key_user_id",
      "end_user"
    ],
    api_key: [
      "metadata.user_api_key_alias",
      "metadata.user_api_key_hash"
    ],
    model: [
      "model"
    ],
    provider: [
      "custom_llm_provider"
    ],
    input_tokens: [
      "prompt_tokens"
    ],
    output_tokens: [
      "completion_tokens"
    ],
    cache_hit: [
      "cache_hit"
    ],
    api_base: [
      "api_base"
    ],
    status: [
      "status"
    ]
  },
  cost_field: "response_cost",
  cost_semantics: "usd_estimate",
  cost_provenance: "gateway_computed",
  cost_scale: 0,
  timestamp_format: "epoch_seconds_decimal",
  billed_by_rule: {
    kind: "field",
    field: "provider"
  },
  default_provider_required: false,
  reject_when_true: [],
  require_equal: [],
  ignore_list: [
    {
      field: "trace_id",
      justification: "trace correlation id, not a cost attribute"
    },
    {
      field: "session_id",
      justification: "session correlation id, not a cost attribute"
    },
    {
      field: "litellm_call_id",
      justification: "LiteLLM-internal call id; `id` is the idempotency key"
    },
    {
      field: "call_type",
      justification: "request kind (completion, embedding), not money"
    },
    {
      field: "stream",
      justification: "transport flag, not a cost attribute"
    },
    {
      field: "cost_breakdown",
      justification: "money: the components of response_cost, which is the request's total"
    },
    {
      field: "autorouter_savings",
      justification: "money: a saving against a baseline, not this request's cost"
    },
    {
      field: "autorouter_savings_estimate",
      justification: "money: an estimated saving, not this request's cost"
    },
    {
      field: "autorouter_baseline_observation",
      justification: "router diagnostics, not this request's cost"
    },
    {
      field: "response_cost_failure_debug_info",
      justification: "money diagnostics for a failed cost calculation; response_cost carries the figure"
    },
    {
      field: "zero_cost_diagnostic",
      justification: "money diagnostics explaining a zero cost; response_cost carries the figure"
    },
    {
      field: "status_fields",
      justification: "status detail, not a cost attribute"
    },
    {
      field: "total_tokens",
      justification: "derivable: prompt_tokens + completion_tokens"
    },
    {
      field: "endTime",
      justification: "end instant; the request books at startTime"
    },
    {
      field: "completionStartTime",
      justification: "latency instant, not a cost attribute"
    },
    {
      field: "response_time",
      justification: "latency, not a cost attribute"
    },
    {
      field: "model_map_information",
      justification: "LiteLLM's pricing-map lookup detail, not this request's cost"
    },
    {
      field: "model_id",
      justification: "deployment id; model carries the model"
    },
    {
      field: "model_group",
      justification: "router alias; model carries the model"
    },
    {
      field: "cache_key",
      justification: "a cache entry key, not an identity or an API key"
    },
    {
      field: "saved_cache_cost",
      justification: "money: a saving from the cache, not this request's cost"
    },
    {
      field: "request_tags",
      justification: "free-form tags; not mapped by default (a new profile version can map them)"
    },
    {
      field: "request_model_access_groups",
      justification: "access-control groups, not a cost attribute"
    },
    {
      field: "requester_ip_address",
      justification: "identity: the caller's IP address is personal data and is not stored"
    },
    {
      field: "user_agent",
      justification: "identity: the caller's user agent is not stored"
    },
    {
      field: "messages",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "response",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "error_str",
      justification: "error text may echo content; not stored"
    },
    {
      field: "error_information",
      justification: "error detail may echo content; not stored"
    },
    {
      field: "model_parameters",
      justification: "request parameters, not a cost attribute"
    },
    {
      field: "hidden_params",
      justification: "LiteLLM internals, not a cost attribute"
    },
    {
      field: "guardrail_information",
      justification: "guardrail results may echo content; not stored"
    },
    {
      field: "standard_built_in_tools_params",
      justification: "tool parameters may carry content; not stored"
    },
    {
      field: "classifier_input",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "originating_request_masked",
      justification: "prompt or response content: dropped at ingestion, never stored"
    }
  ]
};

// src/services/ext-gateway/profiles/litellm-spend-logs-csv.json
var litellm_spend_logs_csv_default = {
  template: "litellm-spend-logs-csv@3",
  gateway: "litellm",
  title: "LiteLLM proxy: a CSV dump of the LiteLLM_SpendLogs table (one row per request)",
  format: "csv",
  doc_urls: [
    "https://raw.githubusercontent.com/BerriAI/litellm/c030191be665ec4432c2b66f2f88a5ae67147c2b/schema.prisma"
  ],
  doc_retrieved_on: "2026-10-01",
  version_notes: [
    "@3: status is mapped (no longer ignored): a row LiteLLM logged as a failure is flagged failed, a true zero (never priced, never a gap, still a counted request). CFO N1.",
    "@2: api_base is mapped (no longer ignored): a row whose base is Floe's own gateway (credit-api.floelabs.xyz) is refused, floe_gateway_traffic, because Floe's gateway already metered it (proxy_requests). CFO S5."
  ],
  unconfirmed: [
    "startTime is a Prisma DateTime stored without a time zone in UTC; a naive value is read as UTC.",
    "spend is LiteLLM's list-price or custom-price figure (float8 text, possibly in exponent form): grade D, billed_by = custom_llm_provider.",
    "The LiteLLM UI 'Usage' CSV is a DAILY aggregate with comma-formatted dollars and is not this export: it is not supported."
  ],
  id_field: "request_id",
  fields: {
    occurred_at: [
      "startTime"
    ],
    person: [
      "user",
      "end_user"
    ],
    api_key: [
      "api_key"
    ],
    model: [
      "model"
    ],
    provider: [
      "custom_llm_provider"
    ],
    input_tokens: [
      "prompt_tokens"
    ],
    output_tokens: [
      "completion_tokens"
    ],
    cache_hit: [
      "cache_hit"
    ],
    api_base: [
      "api_base"
    ],
    status: [
      "status"
    ]
  },
  cost_field: "spend",
  cost_semantics: "usd_estimate",
  cost_provenance: "gateway_computed",
  cost_scale: 0,
  timestamp_format: "iso8601_utc_naive",
  billed_by_rule: {
    kind: "field",
    field: "provider"
  },
  default_provider_required: false,
  reject_when_true: [],
  require_equal: [],
  ignore_list: [
    {
      field: "call_type",
      justification: "request kind, not money"
    },
    {
      field: "total_tokens",
      justification: "derivable: prompt_tokens + completion_tokens"
    },
    {
      field: "endTime",
      justification: "end instant; the request books at startTime"
    },
    {
      field: "request_duration_ms",
      justification: "latency, not a cost attribute"
    },
    {
      field: "completionStartTime",
      justification: "latency instant, not a cost attribute"
    },
    {
      field: "model_id",
      justification: "deployment id; model carries the model"
    },
    {
      field: "model_group",
      justification: "router alias; model carries the model"
    },
    {
      field: "metadata",
      justification: "LiteLLM metadata may carry key owners and content; the mapped columns carry what is stored"
    },
    {
      field: "cache_key",
      justification: "a cache entry key, not an identity or an API key"
    },
    {
      field: "request_tags",
      justification: "free-form tags; not mapped by default"
    },
    {
      field: "team_id",
      justification: "identity of a LiteLLM team; not mapped by default (a new profile version can map it)"
    },
    {
      field: "organization_id",
      justification: "identity of a LiteLLM org; not mapped by default"
    },
    {
      field: "requester_ip_address",
      justification: "identity: the caller's IP address is personal data and is not stored"
    },
    {
      field: "messages",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "response",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "session_id",
      justification: "session correlation id, not a cost attribute"
    },
    {
      field: "mcp_namespaced_tool_name",
      justification: "a tool name, not a person's name"
    },
    {
      field: "billing_agent_id",
      justification: "identity of a LiteLLM billing agent; not mapped by default"
    },
    {
      field: "agent_id",
      justification: "identity of a LiteLLM agent; not mapped by default"
    },
    {
      field: "proxy_server_request",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "litellm_call_id",
      justification: "LiteLLM-internal call id; request_id is the idempotency key"
    },
    {
      field: "created_at",
      justification: "row insert time; the request books at startTime"
    },
    {
      field: "updated_at",
      justification: "row update time, not a cost attribute"
    }
  ]
};

// src/services/ext-gateway/profiles/portkey-logs-export-jsonl.json
var portkey_logs_export_jsonl_default = {
  template: "portkey-logs-export-jsonl@2",
  gateway: "portkey",
  title: "Portkey: logs export, JSONL (LogExportsRequestedData fields)",
  format: "ndjson",
  doc_urls: [
    "https://portkey.ai/docs/product/observability/logs-export.md",
    "https://raw.githubusercontent.com/Portkey-AI/openapi/54c7d35b1c37477cb33bdf5b9c1bd46779b2d6d2/openapi.yaml"
  ],
  doc_retrieved_on: "2026-10-01",
  version_notes: [
    `@2: cost_currency may be absent (read as USD); only an explicit other value is refused. logs-export.md: '| Cost | Cost of the request in cents (USD) |' and '| Cost Currency | Currency of the cost (USD) |'; requested_data is chosen per export, and the doc's own example requests (requested_data: ["id", "created_at", "ai_model", "total_tokens", "cost"]) omit cost_currency.`
  ],
  unconfirmed: [
    "cost is in CENTS (cost_scale -2, applied exactly); whether a line carries it as an integer or a decimal is not documented: both are accepted.",
    "metadata may arrive as an object or as a JSON string: both are read.",
    "Whether a line names the provider ai_org or ai_provider, and tokens req_units/res_units or request_tokens/response_tokens, differs between the spec and the doc example: both are accepted in that order.",
    "Portkey has no API-key field in the export; rows carry no api key."
  ],
  id_field: "id",
  fields: {
    occurred_at: [
      "created_at"
    ],
    person: [
      "metadata._user"
    ],
    model: [
      "ai_model"
    ],
    provider: [
      "ai_org",
      "ai_provider"
    ],
    input_tokens: [
      "req_units",
      "request_tokens"
    ],
    output_tokens: [
      "res_units",
      "response_tokens"
    ]
  },
  cost_field: "cost",
  cost_semantics: "usd_estimate",
  cost_provenance: "gateway_computed",
  cost_scale: -2,
  timestamp_format: "iso8601",
  billed_by_rule: {
    kind: "field",
    field: "provider"
  },
  default_provider_required: false,
  reject_when_true: [],
  require_equal: [
    {
      field: "cost_currency",
      value: "USD",
      reason: "currency_not_usd",
      allowMissing: true
    }
  ],
  ignore_list: [
    {
      field: "trace_id",
      justification: "trace correlation id, not a cost attribute"
    },
    {
      field: "request",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "response",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "is_success",
      justification: "success flag; the cost is in cost"
    },
    {
      field: "total_units",
      justification: "derivable: request + response units"
    },
    {
      field: "request_url",
      justification: "upstream URL, not a cost attribute"
    },
    {
      field: "response_time",
      justification: "latency, not a cost attribute"
    },
    {
      field: "response_status_code",
      justification: "HTTP status, not a cost attribute"
    },
    {
      field: "status_code",
      justification: "HTTP status (doc-example alias), not a cost attribute"
    },
    {
      field: "mode",
      justification: "routing mode, not a cost attribute"
    },
    {
      field: "config",
      justification: "gateway config id, not a cost attribute"
    },
    {
      field: "prompt_slug",
      justification: "a prompt template id; its content is not stored"
    }
  ]
};

// src/services/ext-gateway/profiles/helicone-export-jsonl.json
var helicone_export_jsonl_default = {
  template: "helicone-export-jsonl@1",
  gateway: "helicone",
  title: "Helicone: `npx @helicone/export --format jsonl` (HeliconeRequest objects, one per line)",
  format: "ndjson",
  doc_urls: [
    "https://raw.githubusercontent.com/Helicone/helicone/067d9290acb4f1fc9320e902fc67b4b399b50363/examples/export/typescript/index.ts",
    "https://raw.githubusercontent.com/Helicone/helicone/067d9290acb4f1fc9320e902fc67b4b399b50363/docs/swagger.json",
    "https://docs.helicone.ai/references/how-we-calculate-cost.md"
  ],
  doc_retrieved_on: "2026-10-01",
  unconfirmed: [
    "cost is Helicone's computed USD cost (its published price table): grade D, billed_by = provider (lowercased).",
    "The ignore list names only the properties the research notes of 2026-10-01 cite; the full HeliconeRequest schema in the cited swagger has more. Any other top-level key halts the import (422 listing it) until a new profile version ignores it, with a justification when it looks like money or identity."
  ],
  id_field: "request_id",
  fields: {
    occurred_at: [
      "request_created_at"
    ],
    person: [
      "request_user_id"
    ],
    model: [
      "model",
      "request_model"
    ],
    provider: [
      "provider"
    ],
    input_tokens: [
      "prompt_tokens"
    ],
    output_tokens: [
      "completion_tokens"
    ]
  },
  cost_field: "cost",
  cost_semantics: "usd_estimate",
  cost_provenance: "gateway_computed",
  cost_scale: 0,
  timestamp_format: "iso8601",
  billed_by_rule: {
    kind: "field",
    field: "provider"
  },
  default_provider_required: false,
  reject_when_true: [],
  require_equal: [],
  ignore_list: [
    {
      field: "costUSD",
      justification: "money: an undocumented duplicate of the documented `cost`"
    },
    {
      field: "response_id",
      justification: "response id; request_id is the idempotency key"
    },
    {
      field: "response_created_at",
      justification: "response instant; the request books at request_created_at"
    },
    {
      field: "response_status",
      justification: "HTTP status, not a cost attribute"
    },
    {
      field: "request_body",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "response_body",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "request_properties",
      justification: "Helicone custom properties; not mapped by default (a new profile version can map them)"
    },
    {
      field: "latency",
      justification: "latency, not a cost attribute"
    }
  ]
};

// src/services/ext-gateway/profiles/helicone-export-csv.json
var helicone_export_csv_default = {
  template: "helicone-export-csv@1",
  gateway: "helicone",
  title: "Helicone: `npx @helicone/export --format csv` (12 fixed columns)",
  format: "csv",
  doc_urls: [
    "https://raw.githubusercontent.com/Helicone/helicone/067d9290acb4f1fc9320e902fc67b4b399b50363/examples/export/typescript/index.ts",
    "https://docs.helicone.ai/references/how-we-calculate-cost.md"
  ],
  doc_retrieved_on: "2026-10-01",
  unconfirmed: [
    "The CSV has no provider column and no request id: the id is response_id, and the provider is the one the connection declares (defaultProvider, required).",
    "cost is Helicone's computed USD cost: grade D, billed_by = the declared provider."
  ],
  id_field: "response_id",
  fields: {
    occurred_at: [
      "request_created_at"
    ],
    person: [
      "request_user_id"
    ],
    model: [
      "model"
    ],
    input_tokens: [
      "prompt_tokens"
    ],
    output_tokens: [
      "completion_tokens"
    ]
  },
  cost_field: "cost",
  cost_semantics: "usd_estimate",
  cost_provenance: "gateway_computed",
  cost_scale: 0,
  timestamp_format: "iso8601",
  billed_by_rule: {
    kind: "field",
    field: "provider"
  },
  default_provider_required: true,
  reject_when_true: [],
  require_equal: [],
  ignore_list: [
    {
      field: "response_created_at",
      justification: "response instant; the request books at request_created_at"
    },
    {
      field: "response_status",
      justification: "HTTP status, not a cost attribute"
    },
    {
      field: "request_body",
      justification: "prompt or response content: dropped at ingestion, never stored"
    },
    {
      field: "request_properties",
      justification: "Helicone custom properties; not mapped by default (a new profile version can map them)"
    },
    {
      field: "latency",
      justification: "latency, not a cost attribute"
    }
  ]
};

// src/services/ext-gateway/profiles/openrouter-generation-ndjson.json
var openrouter_generation_ndjson_default = {
  template: "openrouter-generation-ndjson@1",
  gateway: "openrouter",
  title: "OpenRouter: one `GET /api/v1/generation` `data` object per line",
  format: "ndjson",
  doc_urls: [
    "https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation.md",
    "https://openrouter.ai/docs/guides/features/activity.md"
  ],
  doc_retrieved_on: "2026-10-01",
  unconfirmed: [
    "total_cost is OpenRouter's recorded charge for the generation, its billing record: grade B, billed_by = openrouter. Verify against one OpenRouter invoice (L1.3).",
    "created_at carries an offset (e.g. +00:00); it is normalized to UTC exactly.",
    "A BYOK generation (is_byok = true) is refused (byok_not_supported): its money is on the vendor's invoice, not OpenRouter's.",
    "The ignore list is empty: the research notes of 2026-10-01 name only the mapped fields and is_byok. Any other top-level key halts the import (422 listing it) until a new profile version ignores it, with a justification when it looks like money or identity.",
    "Not supported: the Activity CSV (an aggregate with undocumented headers) and Broadcast-to-S3 trace files (nested traces)."
  ],
  id_field: "id",
  fields: {
    occurred_at: [
      "created_at"
    ],
    person: [
      "external_user"
    ],
    model: [
      "model"
    ],
    provider: [
      "provider_name"
    ],
    input_tokens: [
      "native_tokens_prompt",
      "tokens_prompt"
    ],
    output_tokens: [
      "native_tokens_completion",
      "tokens_completion"
    ]
  },
  cost_field: "total_cost",
  cost_semantics: "usd_charge",
  cost_provenance: "vendor_reported",
  cost_provenance_vendor: "openrouter",
  cost_scale: 0,
  timestamp_format: "iso8601",
  billed_by_rule: {
    kind: "constant",
    value: "openrouter"
  },
  default_provider_required: false,
  reject_when_true: [
    {
      field: "is_byok",
      reason: "byok_not_supported"
    }
  ],
  require_equal: [],
  ignore_list: []
};

// src/services/ext-gateway/profiles/floe-canonical-ndjson.json
var floe_canonical_ndjson_default = {
  template: "floe-canonical-ndjson@2",
  gateway: "own",
  title: "Floe canonical gateway-event NDJSON (an own gateway, or any source shaped to this contract)",
  format: "ndjson",
  doc_urls: [
    "https://github.com/Floe-Labs/floe-monorepo/blob/main/docs/decisions/004-cost-normalizer.md"
  ],
  doc_retrieved_on: "2026-10-01",
  version_notes: [
    "@2: optional `cache_hit` (JSON boolean): a profile with no cache_hit mapping cannot tell a cache hit from a paid call, so its $0 rows with tokens are never catalog-priced (CFO S3). A row that omits it is not a cache hit."
  ],
  unconfirmed: [
    "The contract is Floe's own (record 004, 'Gateway-log ingestion'); L1.9 will own it. Required: id, occurred_at (ISO 8601 with Z or an offset), model, provider, cost (USD decimal, as a JSON string or number). Optional: person, api_key, input_tokens, output_tokens, task, campaign, customer, billed_by (defaults to provider), cache_hit (boolean; absent = false)."
  ],
  id_field: "id",
  fields: {
    occurred_at: [
      "occurred_at"
    ],
    person: [
      "person"
    ],
    api_key: [
      "api_key"
    ],
    model: [
      "model"
    ],
    provider: [
      "provider"
    ],
    input_tokens: [
      "input_tokens"
    ],
    output_tokens: [
      "output_tokens"
    ],
    task: [
      "task"
    ],
    campaign: [
      "campaign"
    ],
    customer: [
      "customer"
    ],
    billed_by: [
      "billed_by"
    ],
    cache_hit: [
      "cache_hit"
    ]
  },
  cost_field: "cost",
  cost_semantics: "usd_estimate",
  cost_provenance: "gateway_computed",
  cost_scale: 0,
  timestamp_format: "iso8601",
  billed_by_rule: {
    kind: "field",
    field: "provider"
  },
  default_provider_required: false,
  reject_when_true: [],
  require_equal: [],
  ignore_list: []
};

// src/services/ext-gateway/templates.ts
function load(f) {
  const spec = {
    template: f.template,
    format: f.format,
    idField: f.id_field,
    fields: f.fields,
    costField: f.cost_field,
    costSemantics: f.cost_semantics,
    costProvenance: f.cost_provenance,
    costProvenanceVendor: f.cost_provenance_vendor ?? null,
    costProvenanceFrom: null,
    costProvenanceDeclaration: null,
    costScale: f.cost_scale,
    timestampFormat: f.timestamp_format,
    billedByRule: f.billed_by_rule,
    defaultProvider: null,
    rejectWhenTrue: f.reject_when_true,
    requireEqual: f.require_equal,
    ignoreList: f.ignore_list,
    declaredModels: [],
    docUrl: f.doc_urls[0] ?? null,
    docRetrievedOn: f.doc_retrieved_on,
    ...f.cost_aliases ? { costAliases: f.cost_aliases } : {},
    ...f.contract_version ? { contractVersion: f.contract_version } : {}
  };
  const check = checkSpec(f.default_provider_required ? { ...spec, defaultProvider: "provider" } : spec);
  if (!check.ok) throw new Error(`ext-gateway template ${f.template} is invalid: ${check.detail}`);
  if (!EXT_GATEWAY_COST_PROVENANCES.includes(f.cost_provenance)) {
    throw new Error(`ext-gateway template ${f.template} declares no cost_provenance (${EXT_GATEWAY_COST_PROVENANCES.join(" | ")})`);
  }
  if (f.cost_provenance === "vendor_reported" !== (f.cost_provenance_vendor !== void 0)) {
    throw new Error(`ext-gateway template ${f.template}: cost_provenance_vendor is required for vendor_reported, and only for it`);
  }
  return {
    template: f.template,
    gateway: f.gateway,
    title: f.title,
    docUrls: f.doc_urls,
    docRetrievedOn: f.doc_retrieved_on,
    unconfirmed: f.unconfirmed,
    defaultProviderRequired: f.default_provider_required,
    spec
  };
}
var TEMPLATES = [
  litellm_standard_logging_ndjson_default,
  litellm_spend_logs_csv_default,
  portkey_logs_export_jsonl_default,
  helicone_export_jsonl_default,
  helicone_export_csv_default,
  openrouter_generation_ndjson_default,
  floe_canonical_ndjson_default,
  // L1.9: the canonical contract v3, both forms, built from contract.ts (the served JSON Schema's source too).
  contractTemplateFile("ndjson"),
  contractTemplateFile("csv")
].map((f) => load(f));
function listExtGatewayTemplates() {
  return TEMPLATES;
}

// src/services/ext-gateway/validate-core.ts
var IDS_DERIVED_NOTE = "ids derived; window required";
var DEFAULT_PROVIDER_STAND_IN = "connection-default";
var LIST_LIMIT = 100;
function templateProfile(id) {
  const all = listExtGatewayTemplates();
  const t = all.find((x) => x.template === id);
  if (!t) {
    throw new ExtGatewayError(400, "unknown_template", `Name one of the built-in templates: ${all.map((x) => x.template).join(", ")}.`, { options: all.map((x) => x.template) });
  }
  return { spec: { ...t.spec, defaultProvider: t.defaultProviderRequired ? DEFAULT_PROVIDER_STAND_IN : null }, source: "template" };
}
var NAME_RE = /^[A-Za-z_][A-Za-z0-9_. -]{0,63}$/;
function headerLabel(name, index, format) {
  const looksLikeName = NAME_RE.test(name) && !name.includes("@") && !DECIMAL_RE.test(name) && !INTEGER_RE.test(name) && !INSTANT_RE.test(name);
  return looksLikeName ? name : `${format === "csv" ? "column" : "key"} ${index + 1}`;
}
var KNOWN_PROVIDERS = /* @__PURE__ */ new Set([
  "openai",
  "anthropic",
  "google",
  "gemini",
  "vertex",
  "vertex_ai",
  "bedrock",
  "azure",
  "mistral",
  "cohere",
  "groq",
  "together",
  "together_ai",
  "fireworks",
  "fireworks_ai",
  "openrouter",
  "deepseek",
  "xai",
  "perplexity",
  "meta",
  "ollama"
]);
var MODEL_RE = /^(gpt|claude|gemini|llama|mistral|mixtral|codestral|command|deepseek|grok|qwen|phi|o[1-9]|text-embedding|whisper|tts|dall-e)([-.:_][\w.:-]*)?$/i;
function looksLikeValue(cell) {
  const c = cell.trim();
  return c.includes("@") || DECIMAL_RE.test(c) || INTEGER_RE.test(c) || INSTANT_RE.test(c) || /^\d{4}-\d{2}-\d{2}/.test(c) || /^[^/\s]+\/[^\s]+$/.test(c) || KNOWN_PROVIDERS.has(c.toLowerCase()) || MODEL_RE.test(c);
}
function anyKnownName(format, given) {
  const out = /* @__PURE__ */ new Set();
  const specs = [...listExtGatewayTemplates().map((t) => t.spec), ...given ? [given] : []].filter((x) => x.format === format);
  for (const spec of specs) {
    for (const n of knownFields(spec)) out.add(n);
    for (const i of spec.ignoreList) out.add(i.field);
    out.add("id");
  }
  return out;
}
async function detectFormat(text) {
  for await (const chunk of withoutBom(text)) {
    const t = chunk.trimStart();
    if (t !== "") return t.startsWith("{") ? "ndjson" : "csv";
  }
  return "csv";
}
async function scan(format, text) {
  if (format === "csv") {
    let headers = null;
    let rows2 = 0;
    for await (const r of streamCsv(withoutBom(text))) {
      if (headers === null) headers = r.values.map((h) => h.trim());
      else rows2 += 1;
    }
    if (headers === null || headers.length === 0) throw new ExtGatewayError(422, "empty_file", "The file has no header row.");
    const dupes = headers.map((h, i) => headers.indexOf(h) !== i ? `column ${i + 1}` : null).filter((x) => x !== null);
    if (dupes.length > 0) throw new ExtGatewayError(422, "duplicate_headers", `Repeated headers: ${dupes.join(", ")}.`);
    return { format, headers, rows: rows2 };
  }
  const keys = /* @__PURE__ */ new Set();
  let rows = 0;
  for await (const raw of lines(withoutBom(text))) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    rows += 1;
    try {
      const v = parseJsonExact(line);
      if (isJsonObject(v)) for (const k of Object.keys(v)) keys.add(k);
    } catch {
    }
  }
  return { format, headers: [...keys], rows };
}
var top = (spec, path) => spec.format === "ndjson" ? path.split(".")[0] : path;
function missingRequired(spec, has, providerOptional) {
  const out = [];
  const lacks = (paths) => !paths.some((p) => has.has(top(spec, p)));
  if (spec.idField && lacks([spec.idField])) out.push("id");
  for (const f of ["occurred_at", "model", "provider"]) {
    if (f === "provider" && (providerOptional || spec.defaultProvider || spec.contractVersion)) continue;
    if (lacks(spec.fields[f] ?? [])) out.push(f);
  }
  if (lacks([spec.costField, ...spec.costAliases ?? []])) out.push("cost");
  return out;
}
async function withIds(spec, text) {
  if (!spec.contractVersion) return spec;
  return await contractFileHasIds(spec.format, text()) ? spec : { ...spec, idField: null };
}
async function matchTemplates(s, text) {
  const has = new Set(s.headers);
  const out = [];
  const templates = listExtGatewayTemplates();
  for (let i = 0; i < templates.length; i += 1) {
    const t = templates[i];
    if (t.spec.format !== s.format) continue;
    const spec = await withIds(t.spec, text);
    const known = /* @__PURE__ */ new Set([...knownFields(spec), ...spec.ignoreList.map((x) => x.field)]);
    const matched = s.headers.filter((h) => known.has(h)).length;
    const score = s.headers.length === 0 ? 0 : Math.round(matched / s.headers.length * 1e4) / 1e4;
    const missing = missingRequired(spec, has, t.defaultProviderRequired);
    out.push({ template: t.template, score, missingRequired: missing, complete: missing.length === 0, contract: t.spec.contractVersion ?? 0, order: i });
  }
  out.sort((a, b) => Number(b.complete) - Number(a.complete) || b.score - a.score || b.contract - a.contract || a.order - b.order);
  return out.map(({ template, score, missingRequired: m }) => ({ template, score, missingRequired: m }));
}
function emptyReport(format) {
  return {
    valid: false,
    format,
    profile: null,
    exportRowCount: 0,
    floeRowCount: 0,
    rowCountMatches: false,
    ids: null,
    headers: { mapped: [], ignored: [], unmapped: [], missingRequired: [] },
    refusedRows: null,
    skippedRows: { count: 0, reasons: {} },
    duplicateIds: { inFile: { count: 0, rows: [], truncated: false } },
    bestTemplate: null,
    templates: [],
    fileError: null,
    notes: []
  };
}
var fileErrorOf = (err) => {
  if (err instanceof ExtGatewayError) return { error: err.code, detail: err.detail };
  if (err instanceof CsvSyntaxError) return { error: "malformed_csv", detail: err.message };
  return null;
};
async function validateGatewayFile(input) {
  const idRows = /* @__PURE__ */ new Map();
  const people = /* @__PURE__ */ new Set();
  const given = input.template !== void 0 ? templateProfile(input.template) : input.profile ?? null;
  const report = emptyReport(given?.spec.format ?? "csv");
  try {
    report.format = given?.spec.format ?? await detectFormat(input.text());
    const s = await scan(report.format, input.text());
    report.exportRowCount = s.rows;
    const knownNames = anyKnownName(s.format, given?.spec ?? null);
    if (s.format === "csv" && (s.headers.some(looksLikeValue) || !s.headers.some((h) => knownNames.has(h)))) {
      throw new ExtGatewayError(422, "no_header_row", "The first row is not a header row: none of its cells names a known field. Add the header row.");
    }
    report.templates = await matchTemplates(s, input.text);
    report.bestTemplate = report.templates[0] ?? null;
    const best = report.bestTemplate ? listExtGatewayTemplates().find((t) => t.template === report.bestTemplate.template) : null;
    const base = given?.spec ?? (best ? { ...best.spec, defaultProvider: best.defaultProviderRequired ? DEFAULT_PROVIDER_STAND_IN : null } : null);
    if (base === null) return { report: finish(report), idRows, people };
    if (base.defaultProvider === DEFAULT_PROVIDER_STAND_IN) report.notes.push("provider comes from the connection's defaultProvider");
    report.profile = { template: base.template, source: given?.source ?? "best_match" };
    const spec = await withIds(base, input.text);
    report.ids = spec.idField ? "present" : "derived";
    if (!spec.idField) report.notes.push(IDS_DERIVED_NOTE);
    const known = knownFields(spec);
    const ignored = new Set(spec.ignoreList.map((i) => i.field));
    report.headers.mapped = s.headers.filter((h) => known.has(h));
    const genuine = s.headers.filter((h) => knownNames.has(h)).length * 2 >= s.headers.length;
    const position = (i) => `${s.format === "csv" ? "column" : "key"} ${i + 1}`;
    const label = (h) => genuine ? headerLabel(h, s.headers.indexOf(h), s.format) : position(s.headers.indexOf(h));
    const unmapped2 = s.headers.filter((h) => !known.has(h) && !ignored.has(h));
    report.headers.ignored = s.headers.filter((h) => !known.has(h) && ignored.has(h)).map(label);
    report.headers.unmapped = unmapped2.map(label);
    report.headers.missingRequired = missingRequired(spec, new Set(s.headers), false);
    if (report.headers.missingRequired.length > 0) {
      report.notes.push("rows not checked: required fields are missing");
      return { report: finish(report), idRows, people };
    }
    const reading = { ...spec, ignoreList: [...spec.ignoreList, ...unmapped2.map((field) => ({ field, justification: "validator" }))] };
    await checkRows(reading, input.text(), report, idRows, people);
  } catch (err) {
    const fe = fileErrorOf(err);
    if (fe === null) throw err;
    report.fileError = fe;
    report.refusedRows = null;
  }
  return { report: finish(report), idRows, people };
}
async function checkRows(spec, text, report, idRows, people) {
  const refused = { count: 0, reasons: {}, rows: [], truncated: false };
  const dup = report.duplicateIds.inFile;
  for await (const item of sourceItems(spec, text)) {
    const m = "record" in item ? mapRecord(spec, item.record) : { ok: false, reason: item.rejected.reason, field: item.rejected.field };
    const row = "record" in item ? item.record.row : item.rejected.row;
    if (!m.ok && SKIPPED_ROW_REASONS.has(m.reason)) {
      report.skippedRows.count += 1;
      report.skippedRows.reasons[m.reason] = (report.skippedRows.reasons[m.reason] ?? 0) + 1;
      continue;
    }
    if (!m.ok) {
      refused.count += 1;
      refused.reasons[m.reason] = (refused.reasons[m.reason] ?? 0) + 1;
      if (refused.rows.length < LIST_LIMIT) refused.rows.push({ row, reason: m.reason, ...m.field ? { field: m.field } : {} });
      else refused.truncated = true;
      continue;
    }
    report.floeRowCount += 1;
    if (m.row.person !== null) people.add(m.row.person);
    const id = m.row.externalId;
    if (id === null) continue;
    if (!idRows.has(id)) {
      idRows.set(id, row);
      continue;
    }
    dup.count += 1;
    if (dup.rows.length < LIST_LIMIT) dup.rows.push(row);
    else dup.truncated = true;
  }
  report.refusedRows = refused;
}
function finish(r) {
  r.floeRowCount -= r.duplicateIds.inFile.count;
  r.rowCountMatches = r.fileError === null && r.floeRowCount === r.exportRowCount;
  if (r.fileError === null && !r.rowCountMatches) r.notes.push(`Floe would import ${r.floeRowCount} of the export's ${r.exportRowCount} rows`);
  r.valid = r.fileError === null && r.profile !== null && r.headers.unmapped.length === 0 && r.headers.missingRequired.length === 0 && r.refusedRows !== null && r.refusedRows.count === 0 && r.skippedRows.count === 0 && r.duplicateIds.inFile.count === 0 && r.rowCountMatches;
  return r;
}

// src/services/ext-gateway/utf8.ts
async function* decodeChunks(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fail = () => new ExtGatewayError(422, "invalid_encoding", "The file is not valid UTF-8.");
  for await (const b of bytes) {
    let s;
    try {
      s = decoder.decode(b, { stream: true });
    } catch {
      throw fail();
    }
    if (s.length > 0) yield s;
  }
  let tail;
  try {
    tail = decoder.decode();
  } catch {
    throw fail();
  }
  if (tail.length > 0) yield tail;
}

// src/services/ext-gateway/contract-schema.ts
var CONTRACT_SCHEMA_BASE = "https://credit-api.floelabs.xyz/v1/ext-gateway/contract";
var RULES = [
  "A value is absent when its key is missing, JSON null, or blank text. Text is trimmed before any check.",
  "Each field may be written under its name or a listed synonym; two names present with different values refuse the row (conflicting_<field>).",
  "cost is a decimal STRING (digits, optional fraction; no sign, no exponent), never a JSON number. It is the gateway's own figure, graded D, not the vendor's bill.",
  "occurred_at is ISO 8601 with T, seconds, and Z or a \xB1HH:MM offset, on a real calendar day.",
  "input_tokens and output_tokens are non-negative integers, as JSON integers or digit strings, at most 9223372036854775807.",
  'id: a file carries ids (a CSV id column; an NDJSON file whose first row has an id key) and then every row needs one, or carries none and gets derived ids: its import declares a window, and an overlapping window needs mode=replace ("ids derived; window required"). A row with an id in a file without ids is refused (unexpected_id).',
  "provider may be omitted when model reads provider/model: the provider is the part before the first /, the model the rest. A row with neither is refused (missing_provider).",
  "Any other key or header halts the import (unmapped_fields).",
  "CSV form: the same names as headers, every value text, an empty cell absent. The NDJSON form is the reference."
];
function valueSchema(f) {
  const nullable = (types) => f.required ? types : [...types, "null"];
  switch (f.kind) {
    case "text":
      return { type: nullable(["string"]), minLength: 1, ...f.maxLength ? { maxLength: f.maxLength } : {} };
    case "decimal":
      return { type: nullable(["string"]), pattern: DECIMAL_RE.source, ...f.maxLength ? { maxLength: f.maxLength } : {} };
    case "instant":
      return { type: nullable(["string"]), pattern: INSTANT_RE.source };
    case "integer":
      return { type: nullable(["integer", "string"]), minimum: 0, pattern: INTEGER_RE.source, "x-floe-maximum": MAX_INTEGER };
    case "boolean":
      return { type: nullable(["boolean", "string"]), pattern: "^([Tt][Rr][Uu][Ee]|[Ff][Aa][Ll][Ss][Ee])$", "x-floe-pattern-flags": BOOLEAN_RE.flags };
  }
}
function contractJsonSchema(version) {
  if (!CONTRACT_VERSIONS.map(String).includes(version)) return null;
  const properties = {};
  const allOf = [];
  for (const f of CONTRACT_V3_FIELDS) {
    properties[f.name] = { description: f.description, ...valueSchema(f) };
    for (const s of f.synonyms) properties[s] = { description: `Synonym of ${f.name}.`, "x-floe-synonym-of": f.name, ...valueSchema(f) };
    const names = [f.name, ...f.synonyms];
    if (f.required && f.name !== "id") allOf.push({ anyOf: names.map((n) => ({ required: [n] })) });
  }
  allOf.push({ anyOf: [
    { required: ["provider"], properties: { provider: { type: "string", pattern: "\\S" } } },
    { required: ["model"], properties: { model: { type: "string", pattern: "^[^/]*\\S[^/]*/.*\\S.*$" } } }
  ] });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${CONTRACT_SCHEMA_BASE}/${version}`,
    title: `Floe canonical gateway export, contract v${version}`,
    description: "One gateway request: a line of the NDJSON form or a row of the CSV form.",
    type: "object",
    properties,
    additionalProperties: false,
    allOf,
    "x-floe-contract-version": Number(version),
    "x-floe-templates": { ...CONTRACT_TEMPLATES },
    "x-floe-field-order": CONTRACT_V3_FIELDS.map((f) => f.name),
    "x-floe-rules": RULES
  };
}
export {
  CONTRACT_TEMPLATES,
  CONTRACT_VERSIONS,
  IDS_DERIVED_NOTE,
  LIST_LIMIT,
  contractJsonSchema,
  decodeChunks,
  headerLabel,
  validateGatewayFile
};
