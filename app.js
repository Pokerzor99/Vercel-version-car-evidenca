/** Samo te vrste servisa so v programu (slovensko). */
const DEFAULT_TYPES = [
  { name: "Mali servis", intervalMiles: 15000, intervalDays: 365 },
  { name: "Veliki servis", intervalMiles: 30000, intervalDays: 730 },
  { name: "Zamenjava baterije", intervalMiles: null, intervalDays: 1095 },
  { name: "Zamenjava manjših delov", intervalMiles: 20000, intervalDays: 365 },
  { name: "Zamenjava večjih delov", intervalMiles: 60000, intervalDays: 1825 }
];

const VALID_TYPE_NAMES = new Set(DEFAULT_TYPES.map((t) => t.name));

/** Stara imena → nova (migracija iz prejšnjih verzij). */
const LEGACY_TYPE_MAP = {
  "Menjava olja": "Mali servis",
  "Rotacija pnevmatik": "Mali servis",
  "Pregled zavor": "Veliki servis",
  "Pregled akumulatorja": "Zamenjava baterije",
  "Filter kabine": "Mali servis",
  "Oil Change": "Mali servis",
  "Tire Rotation": "Mali servis",
  "Brake Inspection": "Veliki servis",
  "Battery Check": "Zamenjava baterije",
  "Cabin Air Filter": "Mali servis"
};

function normalizeServiceTypeName(name) {
  if (!name || typeof name !== "string") return "Mali servis";
  const trimmed = name.trim();
  if (VALID_TYPE_NAMES.has(trimmed)) return trimmed;
  if (LEGACY_TYPE_MAP[trimmed]) return LEGACY_TYPE_MAP[trimmed];
  return "Mali servis";
}

function freshState() {
  return { vehicles: [], plans: [], records: [], types: [...DEFAULT_TYPES], syncStatus: null };
}

function migrateState(rawState) {
  if (!rawState || typeof rawState !== "object") return freshState();
  if (!rawState.types || !Array.isArray(rawState.types)) {
    rawState.types = [...DEFAULT_TYPES];
  } else {
    rawState.types = DEFAULT_TYPES.map((def) => {
      const old = rawState.types.find((t) => t.name === def.name);
      return old ? { ...def, ...old, name: def.name } : def;
    });
  }

  rawState.plans = (rawState.plans || []).map((p) => ({
    ...p,
    type: normalizeServiceTypeName(p.type)
  }));

  rawState.records = (rawState.records || []).map((r) => ({
    ...r,
    type: normalizeServiceTypeName(r.type)
  }));

  /** Združi podvojene plane (isto vozilo + ista vrsta). */
  const mergedPlans = [];
  const planKeySeen = new Map();
  for (const p of rawState.plans) {
    const key = `${p.vehicleId}|${p.type}`;
    if (!planKeySeen.has(key)) {
      planKeySeen.set(key, mergedPlans.length);
      mergedPlans.push({ ...p });
    } else {
      const idx = planKeySeen.get(key);
      const a = mergedPlans[idx];
      const dateA = a.lastServiceDate || "";
      const dateB = p.lastServiceDate || "";
      if (dateB > dateA) {
        mergedPlans[idx] = { ...a, ...p };
      }
    }
  }
  rawState.plans = mergedPlans;

  /** Kilometri vozila: referenca ob vnosu + samodejni preračun iz zapisov. */
  if (rawState.vehicles && Array.isArray(rawState.vehicles)) {
    const records = rawState.records || [];
    rawState.vehicles.forEach((v) => {
      if (v.baseMileage == null) v.baseMileage = Number(v.currentMileage) || 0;
      const recs = records.filter((r) => r.vehicleId === v.id);
      v.currentMileage = computeVehicleCurrentMileage(v, recs);
      if (v.vinjetaValidUntilSI === undefined) v.vinjetaValidUntilSI = null;
      if (v.vinjetaValidUntilAT === undefined) v.vinjetaValidUntilAT = null;
      if (v.registracijaValidUntil === undefined) v.registracijaValidUntil = null;
      if (v.status !== "archived") v.status = "active";
    });
  }

  return rawState;
}

function isVehicleActive(v) {
  return v && v.status !== "archived";
}

function getActiveVehicles() {
  return state.vehicles.filter(isVehicleActive);
}

function getArchivedVehicles() {
  return state.vehicles.filter((v) => v.status === "archived");
}

/** Samo aktivna vozila za izbirnike in delovne tokove. */
function getActiveVehicleIdsSet() {
  return new Set(getActiveVehicles().map((v) => v.id));
}

const EVINJETA_URL = "https://evinjeta.dars.si/selfcare/sl/check-validity/request";

function getFirestoreDb() {
  return typeof window !== "undefined" && window.__carMaintenanceDb ? window.__carMaintenanceDb : null;
}

/** ISO datum iz Firestore (niz ali Timestamp). */
function normalizeFirestoreDateValue(val) {
  if (val == null) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object" && val !== null && typeof val.toDate === "function") {
    const dt = val.toDate();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(val);
}

function vehicleDocumentForFirestore(v) {
  return {
    nickname: v.nickname,
    year: v.year,
    make: v.make,
    model: v.model,
    referenceMarketValue: v.referenceMarketValue ?? null,
    baseMileage: v.baseMileage ?? null,
    currentMileage: v.currentMileage ?? null,
    status: v.status === "archived" ? "archived" : "active",
    archivedAt: v.archivedAt ?? null,
    archivedReason: v.archivedReason ?? null
  };
}

function planDocumentForFirestore(p) {
  return {
    vehicleId: p.vehicleId,
    type: p.type,
    intervalMiles: p.intervalMiles ?? null,
    intervalDays: p.intervalDays ?? null,
    lastServiceDate: p.lastServiceDate ?? null,
    lastServiceMileage: p.lastServiceMileage ?? null,
    notes: p.notes ?? null
  };
}

function recordDocumentForFirestore(r) {
  return {
    vehicleId: r.vehicleId,
    type: r.type,
    serviceDate: r.serviceDate,
    mileageAtService: r.mileageAtService,
    cost: r.cost ?? null,
    shopName: r.shopName ?? "",
    notes: r.notes ?? ""
  };
}

async function persistFullStateToFirestore(db) {
  const vIds = new Set(state.vehicles.map((v) => v.id));
  const pIds = new Set(state.plans.map((p) => p.id));
  const rIds = new Set(state.records.map((r) => r.id));

  const [vSnap, pSnap, rSnap, vinSnap] = await Promise.all([
    db.collection("vehicles").get(),
    db.collection("plans").get(),
    db.collection("records").get(),
    db.collection("vinjetas").get()
  ]);

  const delPromises = [];
  vSnap.forEach((d) => {
    if (!vIds.has(d.id)) delPromises.push(d.ref.delete());
  });
  pSnap.forEach((d) => {
    if (!pIds.has(d.id)) delPromises.push(d.ref.delete());
  });
  rSnap.forEach((d) => {
    if (!rIds.has(d.id)) delPromises.push(d.ref.delete());
  });
  vinSnap.forEach((d) => {
    if (!vIds.has(d.id)) delPromises.push(d.ref.delete());
  });
  await Promise.all(delPromises);

  const writePromises = [];
  for (const v of state.vehicles) {
    writePromises.push(db.collection("vehicles").doc(v.id).set(vehicleDocumentForFirestore(v)));
    const vinRef = db.collection("vinjetas").doc(v.id);
    if (!v.vinjetaValidUntilSI && !v.vinjetaValidUntilAT && !v.registracijaValidUntil) {
      writePromises.push(vinRef.delete());
    } else {
      writePromises.push(
        vinRef.set({
          vehicleId: v.id,
          si: v.vinjetaValidUntilSI || null,
          at: v.vinjetaValidUntilAT || null,
          reg: v.registracijaValidUntil || null
        })
      );
    }
  }
  for (const p of state.plans) {
    writePromises.push(db.collection("plans").doc(p.id).set(planDocumentForFirestore(p)));
  }
  for (const r of state.records) {
    writePromises.push(db.collection("records").doc(r.id).set(recordDocumentForFirestore(r)));
  }
  await Promise.all(writePromises);
}

async function loadStateFromFirestore() {
  const db = getFirestoreDb();
  if (!db) {
    state = migrateState(freshState());
    return;
  }
  const [vSnap, pSnap, rSnap, vinSnap] = await Promise.all([
    db.collection("vehicles").get(),
    db.collection("plans").get(),
    db.collection("records").get(),
    db.collection("vinjetas").get()
  ]);

  const vinMap = {};
  vinSnap.forEach((doc) => {
    const d = doc.data();
    vinMap[doc.id] = { si: d.si ?? null, at: d.at ?? null, reg: d.reg ?? null };
  });

  const vehicles = [];
  vSnap.forEach((doc) => {
    const d = doc.data();
    const id = doc.id;
    const vin = vinMap[id] || {};
    vehicles.push({
      id,
      nickname: d.nickname,
      year: d.year,
      make: d.make,
      model: d.model,
      referenceMarketValue: d.referenceMarketValue ?? null,
      baseMileage: d.baseMileage ?? null,
      currentMileage: d.currentMileage ?? null,
      vinjetaValidUntilSI: vin.si ?? d.vinjetaValidUntilSI ?? null,
      vinjetaValidUntilAT: vin.at ?? d.vinjetaValidUntilAT ?? null,
      registracijaValidUntil: vin.reg ?? d.registracijaValidUntil ?? null,
      status: d.status === "archived" ? "archived" : "active",
      archivedAt: d.archivedAt ?? null,
      archivedReason: d.archivedReason ?? null
    });
  });

  const plans = [];
  pSnap.forEach((doc) => {
    const d = doc.data();
    plans.push({
      id: doc.id,
      vehicleId: d.vehicleId,
      type: d.type,
      intervalMiles: d.intervalMiles ?? null,
      intervalDays: d.intervalDays ?? null,
      lastServiceDate: normalizeFirestoreDateValue(d.lastServiceDate),
      lastServiceMileage: d.lastServiceMileage ?? null,
      notes: d.notes ?? null
    });
  });

  const records = [];
  rSnap.forEach((doc) => {
    const d = doc.data();
    records.push({
      id: doc.id,
      vehicleId: d.vehicleId,
      type: d.type,
      serviceDate: normalizeFirestoreDateValue(d.serviceDate),
      mileageAtService: d.mileageAtService,
      cost: d.cost ?? null,
      shopName: d.shopName ?? "",
      notes: d.notes ?? ""
    });
  });

  state = migrateState({ vehicles, plans, records, types: [...DEFAULT_TYPES] });
  for (const plan of state.plans) {
    recalculatePlanLastService(plan.vehicleId, plan.type);
  }
  await loadSyncStatusFromFirestore();
}

/** Zadnja izbira vozila v spustniku e-vinjeta (obnovi se ob renderju). */
let lastVinjetaVehicleId = null;

/** Zadnja izbira vozila na panelu Vinjete (vnos datumov). */
let lastVinjetaPanelVehicleId = null;
let vinjetaPanelFeedbackTimeoutId = null;

let vinjetaLoadTimeoutId = null;
const THEME_KEY = "car-maintenance-theme";
const ZOOM_KEY = "car-maintenance-zoom";
const ZOOM_LEVELS = [1, 1.25, 1.5, 1.75, 2];

let valueChartInstance = null;
let expandedHistoryRecordId = null;
let pendingImportReport = null;

/**
 * Trenutni km vozila = max(referenčni km ob vnosu v evidenco, najvišji km med servisnimi zapisi).
 */
/**
 * Informativna ocena tržne vrednosti (brez API-ja avto.net/mobile.de).
 * Če uporabnik vnese referenčno ceno, se uporabi ta vrednost.
 */
function estimateVehicleValueEur(vehicle) {
  const year = Number(vehicle.year) || new Date().getFullYear();
  const age = Math.max(0, new Date().getFullYear() - year);
  const km = Number(vehicle.currentMileage) || 0;
  let hypotheticalNew = 22000;
  if (year >= 2022) hypotheticalNew = 32000;
  else if (year >= 2018) hypotheticalNew = 27000;
  else if (year >= 2012) hypotheticalNew = 21000;
  else hypotheticalNew = 15000;
  let v = hypotheticalNew * Math.pow(0.88, Math.min(age, 20));
  const kmPenalty = Math.min(0.38, (km / 220000) * 0.42);
  v *= 1 - kmPenalty;
  return Math.round(Math.max(200, v));
}

function getDisplayedMarketValueEur(vehicle) {
  if (vehicle.referenceMarketValue != null && Number(vehicle.referenceMarketValue) > 0) {
    return Math.round(Number(vehicle.referenceMarketValue));
  }
  return estimateVehicleValueEur(vehicle);
}

function getTotalRepairCostEur(vehicleId) {
  return state.records
    .filter((r) => r.vehicleId === vehicleId && r.cost != null && !Number.isNaN(Number(r.cost)))
    .reduce((sum, r) => sum + Number(r.cost), 0);
}

function buildAvtoNetSearchUrl(vehicle) {
  const make = encodeURIComponent((vehicle.make || "").trim());
  const model = encodeURIComponent((vehicle.model || "").trim());
  const y = vehicle.year || "";
  return `https://www.avto.net/Ads/results.asp?znamka=${make}&model=${model}&letnik_od=${y}&letnik_do=${y}`;
}

function buildMobileDeSearchUrl(vehicle) {
  const q = encodeURIComponent(`${vehicle.make || ""} ${vehicle.model || ""}`.trim());
  return `https://suchen.mobile.de/fahrzeuge/search.html?fn=search&vc=Car&description=${q}`;
}

function computeVehicleCurrentMileage(vehicle, recordsForVehicle) {
  const base = vehicle.baseMileage != null ? Number(vehicle.baseMileage) : Number(vehicle.currentMileage) || 0;
  const maxRec =
    recordsForVehicle.length > 0
      ? Math.max(...recordsForVehicle.map((r) => Number(r.mileageAtService)))
      : null;
  return maxRec != null ? Math.max(base, maxRec) : base;
}

let state = freshState();

function recalculateVehicleMileage(vehicleId) {
  const v = state.vehicles.find((x) => x.id === vehicleId);
  if (!v) return;
  if (v.baseMileage == null) v.baseMileage = Number(v.currentMileage) || 0;
  const recs = state.records.filter((r) => r.vehicleId === vehicleId);
  v.currentMileage = computeVehicleCurrentMileage(v, recs);
}

const refs = {
  vehicleForm: document.getElementById("vehicleForm"),
  vehicleList: document.getElementById("vehicleList"),
  planForm: document.getElementById("planForm"),
  recordForm: document.getElementById("recordForm"),
  planVehicleSelect: document.getElementById("planVehicleSelect"),
  recordVehicleSelect: document.getElementById("recordVehicleSelect"),
  planTypeSelect: document.getElementById("planTypeSelect"),
  recordTypeSelect: document.getElementById("recordTypeSelect"),
  dueDashboard: document.getElementById("dueDashboard"),
  historyList: document.getElementById("historyList"),
  vehicleItemTemplate: document.getElementById("vehicleItemTemplate"),
  vehicleFormVehicleId: document.getElementById("vehicleFormVehicleId"),
  vehicleFormHeading: document.getElementById("vehicleFormHeading"),
  vehicleFormSubmitBtn: document.getElementById("vehicleFormSubmitBtn"),
  cancelVehicleEditBtn: document.getElementById("cancelVehicleEditBtn"),
  filterVehicleSelect: document.getElementById("filterVehicleSelect"),
  planEditCard: document.getElementById("planEditCard"),
  planEditForm: document.getElementById("planEditForm"),
  planEditPlanId: document.getElementById("planEditPlanId"),
  planEditSummary: document.getElementById("planEditSummary"),
  planEditIntervalMiles: document.getElementById("planEditIntervalMiles"),
  planEditIntervalDays: document.getElementById("planEditIntervalDays"),
  planEditLastDate: document.getElementById("planEditLastDate"),
  planEditLastMileage: document.getElementById("planEditLastMileage"),
  cancelPlanEditBtn: document.getElementById("cancelPlanEditBtn"),
  recordFormRecordId: document.getElementById("recordFormRecordId"),
  recordFormSubmitBtn: document.getElementById("recordFormSubmitBtn"),
  cancelRecordEditBtn: document.getElementById("cancelRecordEditBtn"),
  themeToggle: document.getElementById("themeToggle"),
  zoomSelect: document.getElementById("zoomSelect"),
  vinjetaVehicleSelect: document.getElementById("vinjetaVehicleSelect"),
  vinjetaOpenBtn: document.getElementById("vinjetaOpenBtn"),
  vinjetaModal: document.getElementById("vinjetaModal"),
  vinjetaModalBackdrop: document.getElementById("vinjetaModalBackdrop"),
  vinjetaModalClose: document.getElementById("vinjetaModalClose"),
  vinjetaModalPlate: document.getElementById("vinjetaModalPlate"),
  vinjetaLoader: document.getElementById("vinjetaLoader"),
  vinjetaIframe: document.getElementById("vinjetaIframe"),
  vinjetaPanelVehicleSelect: document.getElementById("vinjetaPanelVehicleSelect"),
  vinjetaPanelForm: document.getElementById("vinjetaPanelForm"),
  vinjetaPanelVehicleSummary: document.getElementById("vinjetaPanelVehicleSummary"),
  vinjetaPanelSi: document.getElementById("vinjetaPanelSi"),
  vinjetaPanelAt: document.getElementById("vinjetaPanelAt"),
  vinjetaPanelReg: document.getElementById("vinjetaPanelReg"),
  vinjetaPanelSaveBtn: document.getElementById("vinjetaPanelSaveBtn"),
  vinjetaPanelSaveFeedback: document.getElementById("vinjetaPanelSaveFeedback"),
  vinjetaEvidenceTable: document.getElementById("vinjetaEvidenceTable"),
  dueSoonCardBody: document.getElementById("dueSoonCardBody"),
  vehicleArchivedSection: document.getElementById("vehicleArchivedSection"),
  vehicleArchivedList: document.getElementById("vehicleArchivedList"),
  vaultVehicleForm: document.getElementById("vaultVehicleForm"),
  vaultFileInput: document.getElementById("vaultFileInput"),
  vaultUploadBtn: document.getElementById("vaultUploadBtn"),
  vaultUploadHint: document.getElementById("vaultUploadHint"),
  vaultDocumentsBody: document.getElementById("vaultDocumentsBody"),
  auditDateFrom: document.getElementById("auditDateFrom"),
  auditDateTo: document.getElementById("auditDateTo"),
  auditQuickRange: document.getElementById("auditQuickRange"),
  auditApplyFilterBtn: document.getElementById("auditApplyFilterBtn"),
  auditLogBody: document.getElementById("auditLogBody"),
  auditLogEmpty: document.getElementById("auditLogEmpty"),
  lineLastSync: document.getElementById("lineLastSync"),
  lineLastBackup: document.getElementById("lineLastBackup"),
  btnExportCsv: document.getElementById("btnExportCsv"),
  btnImportCsvTrigger: document.getElementById("btnImportCsvTrigger"),
  csvImportInput: document.getElementById("csvImportInput"),
  btnBackupNow: document.getElementById("btnBackupNow"),
  importPreview: document.getElementById("importPreview"),
  importPreviewText: document.getElementById("importPreviewText"),
  btnImportApply: document.getElementById("btnImportApply"),
  btnImportCancel: document.getElementById("btnImportCancel")
};

/** Izbrano vozilo za filter: "" = vsa. */
let filterVehicleId = "";

async function touchSuccessfulSync(db) {
  try {
    await db.collection("sync_status").doc("global").set(
      { lastSuccessfulSyncAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    await loadSyncStatusFromFirestore();
  } catch (e) {
    console.error(e);
  }
}

async function loadSyncStatusFromFirestore() {
  const db = getFirestoreDb();
  if (!db) return;
  try {
    const doc = await db.collection("sync_status").doc("global").get();
    state.syncStatus = doc.exists ? doc.data() : {};
    updateSyncStatusLines();
  } catch (e) {
    console.error(e);
  }
}

function formatFirestoreTime(val) {
  if (val == null) return "—";
  if (typeof val.toDate === "function") {
    return formatDateEuropean(dateToIsoLocal(val.toDate()));
  }
  if (typeof val === "string") return formatDateEuropean(val.slice(0, 10));
  return "—";
}

function updateSyncStatusLines() {
  const s = state.syncStatus || {};
  if (refs.lineLastSync) {
    refs.lineLastSync.textContent = `Zadnja uspešna sinhronizacija: ${formatFirestoreTime(s.lastSuccessfulSyncAt)}`;
  }
  if (refs.lineLastBackup) {
    refs.lineLastBackup.textContent = `Zadnja varnostna kopija: ${formatFirestoreTime(s.lastBackupAt)}`;
  }
}

async function appendAuditLog(entry) {
  const db = getFirestoreDb();
  if (!db) return;
  try {
    await db.collection("audit_logs").add({
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      actorType: "client",
      actorId: "browser",
      actionType: entry.actionType,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      summary: entry.summary ?? "",
      meta: entry.meta ?? null
    });
  } catch (e) {
    console.error("appendAuditLog", e);
  }
}

async function logAuditEntry(action, entity, summary) {
  const db = getFirestoreDb();
  if (!db) return;
  try {
    await db.collection("auditLog").add({
      ts: new Date().toISOString(),
      action,
      entity,
      summary
    });
  } catch (e) {
    console.warn("Audit log failed:", e);
  }
}

async function saveState() {
  const db = getFirestoreDb();
  if (!db) {
    console.warn("Firestore ni na voljo; podatki se ne shranijo v oblak.");
    return;
  }
  try {
    await persistFullStateToFirestore(db);
    await touchSuccessfulSync(db);
  } catch (err) {
    console.error(err);
    alert("Napaka pri shranjevanju v oblak.");
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function toDate(value) {
  return value ? new Date(`${value}T00:00:00`) : null;
}

/** ISO yyyy-mm-dd → prikaz dd/mm/yyyy */
function formatDateEuropean(iso) {
  if (!iso || typeof iso !== "string") return "";
  const t = iso.trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const [y, m, d] = t.split("-");
    return `${d}/${m}/${y}`;
  }
  return iso.trim();
}

/**
 * Vnos dd/mm/yyyy, dd.mm.yyyy ali že shranjen ISO yyyy-mm-dd.
 * @returns {string|null} ISO yyyy-mm-dd
 */
function parseServiceDateInput(str) {
  if (!str || typeof str !== "string") return null;
  const trimmed = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Stanje veljavnosti končnega datuma vinjete (SLO / AT). */
function vinjetaExpiryStatus(isoDate) {
  if (!isoDate || typeof isoDate !== "string") {
    return { key: "none", label: "Ni vnosa", badgeClass: "vinjeta-badge vinjeta-badge--none" };
  }
  const end = toDate(isoDate);
  if (!end || Number.isNaN(end.getTime())) {
    return { key: "none", label: "Ni vnosa", badgeClass: "vinjeta-badge vinjeta-badge--none" };
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);
  const diff = (endDay - today) / 86400000;
  if (diff < 0) return { key: "expired", label: "Poteklo", badgeClass: "vinjeta-badge vinjeta-badge--expired" };
  if (diff <= 30) return { key: "soon", label: "Kmalu poteče", badgeClass: "vinjeta-badge vinjeta-badge--soon" };
  return { key: "ok", label: "Veljavno", badgeClass: "vinjeta-badge vinjeta-badge--ok" };
}

function refreshVinjetaPanelUI() {
  const sel = refs.vinjetaPanelVehicleSelect;
  const form = refs.vinjetaPanelForm;
  if (!sel || !form) return;

  const activeVehicles = getActiveVehicles();
  if (!activeVehicles.length) {
    sel.innerHTML = '<option value="">Najprej dodaj vozila na zavihku »Vozila«</option>';
    sel.disabled = true;
    form.hidden = true;
    if (refs.vinjetaPanelSi) refs.vinjetaPanelSi.value = "";
    if (refs.vinjetaPanelAt) refs.vinjetaPanelAt.value = "";
    if (refs.vinjetaPanelReg) refs.vinjetaPanelReg.value = "";
    if (refs.vinjetaPanelVehicleSummary) refs.vinjetaPanelVehicleSummary.textContent = "";
    if (refs.vinjetaPanelSaveBtn) refs.vinjetaPanelSaveBtn.disabled = true;
    lastVinjetaPanelVehicleId = null;
    return;
  }

  sel.disabled = false;
  const vehicleOptions = activeVehicles
    .map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.nickname)} (${v.year} ${v.make} ${v.model})</option>`)
    .join("");
  sel.innerHTML = `<option value="">Izberi vozilo …</option>${vehicleOptions}`;

  const keep =
    lastVinjetaPanelVehicleId && activeVehicles.some((v) => v.id === lastVinjetaPanelVehicleId);
  sel.value = keep ? lastVinjetaPanelVehicleId : "";

  applyVinjetaPanelSelection();
}

function applyVinjetaPanelSelection() {
  const sel = refs.vinjetaPanelVehicleSelect;
  const form = refs.vinjetaPanelForm;
  const si = refs.vinjetaPanelSi;
  const at = refs.vinjetaPanelAt;
  const reg = refs.vinjetaPanelReg;
  const sum = refs.vinjetaPanelVehicleSummary;
  if (!sel || !form || !si || !at || !reg) return;

  const id = sel.value || "";
  lastVinjetaPanelVehicleId = id || null;

  if (!id) {
    form.hidden = true;
    si.value = "";
    at.value = "";
    reg.value = "";
    if (sum) sum.textContent = "";
    if (refs.vinjetaPanelSaveBtn) refs.vinjetaPanelSaveBtn.disabled = true;
    return;
  }

  const v = state.vehicles.find((x) => x.id === id);
  if (!v) {
    form.hidden = true;
    if (refs.vinjetaPanelSaveBtn) refs.vinjetaPanelSaveBtn.disabled = true;
    return;
  }

  form.hidden = false;
  if (refs.vinjetaPanelSaveBtn) refs.vinjetaPanelSaveBtn.disabled = false;
  if (sum) {
    sum.innerHTML = `<strong>${escapeHtml(v.nickname)}</strong> – ${escapeHtml(String(v.year))} ${escapeHtml(v.make)} ${escapeHtml(v.model)}`;
  }
  si.value = formatDateEuropean(v.vinjetaValidUntilSI);
  at.value = formatDateEuropean(v.vinjetaValidUntilAT);
  reg.value = formatDateEuropean(v.registracijaValidUntil);
}

function renderVinjetaEvidenceBlocks() {
  const tableWrap = refs.vinjetaEvidenceTable;
  if (!tableWrap) return;

  const allowed = new Set(getFilteredVehicleIds());
  const list = state.vehicles.filter((v) => allowed.has(v.id));

  if (!list.length) {
    const msg = getActiveVehicles().length
      ? "Ni vozil za izbran filter. Spremeni »Prikaži vozilo« zgoraj."
      : "Ni vozil v evidenci.";
    tableWrap.innerHTML = `<p class="hint">${msg}</p>`;
    return;
  }

  const rows = list
    .map((v) => {
      const stSI = vinjetaExpiryStatus(v.vinjetaValidUntilSI);
      const stAT = vinjetaExpiryStatus(v.vinjetaValidUntilAT);
      const stReg = vinjetaExpiryStatus(v.registracijaValidUntil);
      const dSI = v.vinjetaValidUntilSI ? formatDateEuropean(v.vinjetaValidUntilSI) : "—";
      const dAT = v.vinjetaValidUntilAT ? formatDateEuropean(v.vinjetaValidUntilAT) : "—";
      const dReg = v.registracijaValidUntil ? formatDateEuropean(v.registracijaValidUntil) : "—";
      return `<tr>
        <td><strong>${escapeHtml(v.nickname)}</strong></td>
        <td>${escapeHtml(String(v.year))} ${escapeHtml(v.make)} ${escapeHtml(v.model)}</td>
        <td>${escapeHtml(dSI)}<br><span class="${stSI.badgeClass}">${escapeHtml(stSI.label)}</span></td>
        <td>${escapeHtml(dAT)}<br><span class="${stAT.badgeClass}">${escapeHtml(stAT.label)}</span></td>
        <td>${escapeHtml(dReg)}<br><span class="${stReg.badgeClass}">${escapeHtml(stReg.label)}</span></td>
      </tr>`;
    })
    .join("");

  tableWrap.innerHTML = `
    <div class="table-scroll">
      <table class="vinjeta-table">
        <thead>
          <tr>
            <th>Tablica</th>
            <th>Vozilo</th>
            <th>Slovenija</th>
            <th>Avstrija</th>
            <th>Registracija</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function saveVinjetaPanelForm() {
  const sel = refs.vinjetaPanelVehicleSelect;
  if (!sel || !sel.value) {
    alert("Najprej izberi vozilo.");
    return;
  }
  const v = state.vehicles.find((x) => x.id === sel.value);
  if (!v) return;

  const siRaw = refs.vinjetaPanelSi?.value?.trim() ?? "";
  const atRaw = refs.vinjetaPanelAt?.value?.trim() ?? "";
  const regRaw = refs.vinjetaPanelReg?.value?.trim() ?? "";

  if (siRaw) {
    const p = parseServiceDateInput(siRaw);
    if (!p) {
      alert(`Neveljaven datum za Slovenijo. Uporabi dd/mm/yyyy.`);
      return;
    }
    v.vinjetaValidUntilSI = p;
  } else {
    v.vinjetaValidUntilSI = null;
  }

  if (atRaw) {
    const p = parseServiceDateInput(atRaw);
    if (!p) {
      alert(`Neveljaven datum za Avstrijo. Uporabi dd/mm/yyyy.`);
      return;
    }
    v.vinjetaValidUntilAT = p;
  } else {
    v.vinjetaValidUntilAT = null;
  }

  if (regRaw) {
    const p = parseServiceDateInput(regRaw);
    if (!p) {
      alert(`Neveljaven datum za registracijo. Uporabi dd/mm/yyyy.`);
      return;
    }
    v.registracijaValidUntil = p;
  } else {
    v.registracijaValidUntil = null;
  }

  const feedbackEl = refs.vinjetaPanelSaveFeedback;
  if (feedbackEl) {
    feedbackEl.hidden = true;
    feedbackEl.textContent = "";
    feedbackEl.classList.remove("vinjeta-save-feedback--success", "vinjeta-save-feedback--error");
  }
  clearTimeout(vinjetaPanelFeedbackTimeoutId);
  vinjetaPanelFeedbackTimeoutId = null;

  try {
    const db = getFirestoreDb();
    if (!db) {
      throw new Error("Firestore ni na voljo");
    }
    await persistFullStateToFirestore(db);
    const siDisp = v.vinjetaValidUntilSI ? formatDateEuropean(v.vinjetaValidUntilSI) : "—";
    const atDisp = v.vinjetaValidUntilAT ? formatDateEuropean(v.vinjetaValidUntilAT) : "—";
    const regDisp = v.registracijaValidUntil ? formatDateEuropean(v.registracijaValidUntil) : "—";
    await logAuditEntry(
      "SHRANJENO",
      "Vinjeta / Registracija",
      `${v.nickname} – SI: ${siDisp} AT: ${atDisp} Reg: ${regDisp}`
    );
    renderAll();
    if (feedbackEl) {
      feedbackEl.textContent = "Shranjeno ✓";
      feedbackEl.classList.add("vinjeta-save-feedback--success");
      feedbackEl.hidden = false;
      vinjetaPanelFeedbackTimeoutId = setTimeout(() => {
        feedbackEl.hidden = true;
        feedbackEl.textContent = "";
        feedbackEl.classList.remove("vinjeta-save-feedback--success", "vinjeta-save-feedback--error");
        vinjetaPanelFeedbackTimeoutId = null;
      }, 3000);
    }
  } catch (err) {
    console.error(err);
    if (feedbackEl) {
      feedbackEl.textContent = "Napaka pri shranjevanju.";
      feedbackEl.classList.add("vinjeta-save-feedback--error");
      feedbackEl.hidden = false;
      vinjetaPanelFeedbackTimeoutId = setTimeout(() => {
        feedbackEl.hidden = true;
        feedbackEl.textContent = "";
        feedbackEl.classList.remove("vinjeta-save-feedback--success", "vinjeta-save-feedback--error");
        vinjetaPanelFeedbackTimeoutId = null;
      }, 3000);
    }
  }
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function statusForPlan(plan, vehicle) {
  const today = new Date();
  const lastDate = toDate(plan.lastServiceDate);
  const intervalDays = Number(plan.intervalDays) || null;
  const intervalMiles = Number(plan.intervalMiles) || null;
  const currentMileage = Number(vehicle.currentMileage);
  const lastMileage = Number(plan.lastServiceMileage);

  let overdue = false;
  let soon = false;

  if (intervalDays && lastDate) {
    const dueDate = addDays(lastDate, intervalDays);
    const soonDate = addDays(today, 30);
    overdue = overdue || today >= dueDate;
    soon = soon || dueDate <= soonDate;
  }

  if (intervalMiles && Number.isFinite(lastMileage)) {
    const dueMileage = lastMileage + intervalMiles;
    overdue = overdue || currentMileage >= dueMileage;
    soon = soon || dueMileage - currentMileage <= 500;
  }

  if (overdue) return "overdue";
  if (soon) return "soon";
  return "good";
}

function statusLabel(status) {
  if (status === "overdue") return "ZAPADLO";
  if (status === "soon") return "KMALU";
  return "V REDU";
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Razlika v dneh od danes do ciljnega datuma (negativno = preteklost). */
function daysFromTodayTo(isoDate) {
  if (!isoDate || typeof isoDate !== "string") return null;
  const end = toDate(isoDate);
  if (!end || Number.isNaN(end.getTime())) return null;
  const t = startOfDay(new Date());
  const e = startOfDay(end);
  return Math.round((e - t) / 86400000);
}

function dueSoonBucketForDays(days) {
  if (days == null || Number.isNaN(days)) return null;
  if (days < 0) return "overdue";
  if (days <= 30) return "d30";
  if (days <= 60) return "d60";
  if (days <= 90) return "d90";
  return null;
}

function dateToIsoLocal(d) {
  if (!d || Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Zbere elemente za kartico 30/60/90 (samo aktivna vozila).
 */
function collectDueSoonItems() {
  const buckets = { overdue: [], d30: [], d60: [], d90: [] };
  const add = (bucket, title, detail, plate) => {
    if (!buckets[bucket]) return;
    buckets[bucket].push({ title, detail, plate });
  };

  for (const vehicle of getActiveVehicles()) {
    const plate = vehicle.nickname || vehicle.id;

    for (const plan of state.plans.filter((p) => p.vehicleId === vehicle.id)) {
      const intervalDays = Number(plan.intervalDays) || null;
      const intervalMiles = Number(plan.intervalMiles) || null;
      const lastMileage = Number(plan.lastServiceMileage);
      const cur = Number(vehicle.currentMileage);

      if (intervalMiles && Number.isFinite(lastMileage)) {
        const dueM = lastMileage + intervalMiles;
        if (cur >= dueM) {
          add("overdue", `Plan: ${plan.type}`, `Zapadlo po km (rok ${dueM.toLocaleString("sl-SI")} km)`, plate);
        }
      }

      if (intervalDays && plan.lastServiceDate) {
        const last = toDate(plan.lastServiceDate);
        if (last && !Number.isNaN(last.getTime())) {
          const dueDate = addDays(last, intervalDays);
          const days = Math.round((startOfDay(dueDate) - startOfDay(new Date())) / 86400000);
          const b = dueSoonBucketForDays(days);
          if (b) {
            add(b, `Plan: ${plan.type}`, `Rok servisa: ${formatDateEuropean(dateToIsoLocal(dueDate))}`, plate);
          }
        }
      }
    }

    if (vehicle.vinjetaValidUntilSI) {
      const d = daysFromTodayTo(vehicle.vinjetaValidUntilSI);
      const b = dueSoonBucketForDays(d);
      if (b) add(b, "Vinjeta SI", `Veljavnost do ${formatDateEuropean(vehicle.vinjetaValidUntilSI)}`, plate);
    }
    if (vehicle.vinjetaValidUntilAT) {
      const d = daysFromTodayTo(vehicle.vinjetaValidUntilAT);
      const b = dueSoonBucketForDays(d);
      if (b) add(b, "Vinjeta AT", `Veljavnost do ${formatDateEuropean(vehicle.vinjetaValidUntilAT)}`, plate);
    }
    if (vehicle.registracijaValidUntil) {
      const d = daysFromTodayTo(vehicle.registracijaValidUntil);
      const b = dueSoonBucketForDays(d);
      if (b) add(b, "Registracija", `Veljavnost do ${formatDateEuropean(vehicle.registracijaValidUntil)}`, plate);
    }
  }

  return buckets;
}

function renderDueSoonCard() {
  const host = document.getElementById("dueSoonCardBody");
  if (!host) return;
  const buckets = collectDueSoonItems();
  const sections = [
    { key: "overdue", label: "Zapadlo" },
    { key: "d30", label: "Do 30 dni" },
    { key: "d60", label: "31–60 dni" },
    { key: "d90", label: "61–90 dni" }
  ];
  const hasAny = sections.some((s) => buckets[s.key].length);
  if (!hasAny) {
    host.innerHTML = '<p class="hint">Ni elementov v izbranih oknih (samo aktivna vozila).</p>';
    return;
  }
  host.innerHTML = sections
    .map((s) => {
      const rows = buckets[s.key];
      if (!rows.length) return "";
      const inner = rows
        .map(
          (r) => `
        <tr>
          <td><strong>${escapeHtml(r.plate)}</strong></td>
          <td>${escapeHtml(r.title)}</td>
          <td>${escapeHtml(r.detail)}</td>
        </tr>`
        )
        .join("");
      return `
      <div class="due-soon-bucket">
        <h3 class="due-soon-bucket-title">${escapeHtml(s.label)}</h3>
        <div class="table-scroll">
          <table class="vinjeta-table due-soon-table">
            <thead><tr><th>Tablica</th><th>Element</th><th>Podrobnosti</th></tr></thead>
            <tbody>${inner}</tbody>
          </table>
        </div>
      </div>`;
    })
    .join("");
}

function getFilteredVehicleIds() {
  const active = getActiveVehicles();
  const activeIds = new Set(active.map((v) => v.id));
  if (filterVehicleId) {
    if (!activeIds.has(filterVehicleId)) return [];
    return [filterVehicleId];
  }
  return active.map((v) => v.id);
}

function refreshSelects() {
  const activeList = getActiveVehicles();
  if (filterVehicleId && !activeList.some((v) => v.id === filterVehicleId)) {
    filterVehicleId = "";
  }

  const vehicleOptions = activeList
    .map((v) => `<option value="${v.id}">${escapeHtml(v.nickname)} (${v.year} ${v.make} ${v.model})</option>`)
    .join("");

  const emptyOpt = `<option value="">Izberi vozilo</option>`;
  refs.planVehicleSelect.innerHTML = emptyOpt + vehicleOptions;
  refs.recordVehicleSelect.innerHTML = emptyOpt + vehicleOptions;

  const typeOptions = state.types
    .map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`)
    .join("");
  const emptyType = `<option value="">Izberi vrsto servisa</option>`;
  refs.planTypeSelect.innerHTML = emptyType + typeOptions;
  refs.recordTypeSelect.innerHTML = emptyType + typeOptions;

  const filterOpt = `<option value="">Vsa vozila</option>${vehicleOptions}`;
  refs.filterVehicleSelect.innerHTML = filterOpt;
  refs.filterVehicleSelect.value = filterVehicleId;

  refreshVinjetaVehicleSelect();
}

function refreshVinjetaVehicleSelect() {
  const sel = refs.vinjetaVehicleSelect;
  const btn = refs.vinjetaOpenBtn;
  if (!sel || !btn) return;

  const active = getActiveVehicles();
  const vehicleOptions = active
    .map((v) => `<option value="${v.id}">${escapeHtml(v.nickname)} (${v.year} ${v.make} ${v.model})</option>`)
    .join("");

  if (!active.length) {
    sel.innerHTML = `<option value="">Ni vozil</option>`;
    sel.disabled = true;
    btn.disabled = true;
    lastVinjetaVehicleId = null;
    return;
  }

  sel.disabled = false;
  sel.innerHTML = `<option value="">Izberi vozilo</option>${vehicleOptions}`;

  if (lastVinjetaVehicleId && active.some((v) => v.id === lastVinjetaVehicleId)) {
    sel.value = lastVinjetaVehicleId;
  } else if (filterVehicleId && active.some((v) => v.id === filterVehicleId)) {
    sel.value = filterVehicleId;
    lastVinjetaVehicleId = filterVehicleId;
  } else {
    sel.value = active[0].id;
    lastVinjetaVehicleId = active[0].id;
  }

  btn.disabled = !sel.value;
}

function openVinjetaModal() {
  const sel = refs.vinjetaVehicleSelect;
  const id = sel && sel.value;
  if (!id) {
    alert("Izberi vozilo.");
    return;
  }
  lastVinjetaVehicleId = id;
  const vehicle = state.vehicles.find((v) => v.id === id);
  const tablica = vehicle ? vehicle.nickname : "";

  refs.vinjetaModalPlate.innerHTML = tablica
    ? `Tablica: <strong>${escapeHtml(tablica)}</strong> (za prihodnjo uporabo v URL-ju)`
    : "";

  refs.vinjetaLoader.hidden = false;

  refs.vinjetaModal.hidden = false;
  refs.vinjetaModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  clearTimeout(vinjetaLoadTimeoutId);
  vinjetaLoadTimeoutId = setTimeout(() => {
    if (refs.vinjetaLoader) refs.vinjetaLoader.hidden = true;
  }, 30000);

  refs.vinjetaIframe.src = EVINJETA_URL;

  refs.vinjetaModalClose.focus();
}

function closeVinjetaModal() {
  clearTimeout(vinjetaLoadTimeoutId);
  vinjetaLoadTimeoutId = null;
  refs.vinjetaModal.hidden = true;
  refs.vinjetaModal.setAttribute("aria-hidden", "true");
  refs.vinjetaIframe.src = "about:blank";
  document.body.style.overflow = "";
  if (refs.vinjetaLoader) refs.vinjetaLoader.hidden = false;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob(["\uFEFF" + text], { type: mime || "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvEscapeCell(val) {
  const s = String(val ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(headers, rows) {
  const h = headers.map(csvEscapeCell).join(",");
  const body = rows.map((row) => row.map(csvEscapeCell).join(",")).join("\n");
  return `${h}\n${body}\n`;
}

function exportAllCsv() {
  const vHeader = [
    "id",
    "nickname",
    "year",
    "make",
    "model",
    "status",
    "referenceMarketValue",
    "baseMileage",
    "currentMileage"
  ];
  const vRows = state.vehicles.map((v) => [
    v.id,
    v.nickname,
    v.year,
    v.make,
    v.model,
    v.status || "active",
    v.referenceMarketValue ?? "",
    v.baseMileage ?? "",
    v.currentMileage ?? ""
  ]);
  downloadTextFile("vehicles.csv", rowsToCsv(vHeader, vRows));

  const pHeader = ["id", "vehicleId", "type", "intervalMiles", "intervalDays", "lastServiceDate", "lastServiceMileage", "notes"];
  const pRows = state.plans.map((p) => [
    p.id,
    p.vehicleId,
    p.type,
    p.intervalMiles ?? "",
    p.intervalDays ?? "",
    p.lastServiceDate ?? "",
    p.lastServiceMileage ?? "",
    p.notes ?? ""
  ]);
  downloadTextFile("plans.csv", rowsToCsv(pHeader, pRows));

  const rHeader = ["id", "vehicleId", "type", "serviceDate", "mileageAtService", "cost", "shopName", "notes"];
  const rRows = state.records.map((r) => [
    r.id,
    r.vehicleId,
    r.type,
    r.serviceDate,
    r.mileageAtService,
    r.cost ?? "",
    r.shopName ?? "",
    r.notes ?? ""
  ]);
  downloadTextFile("records.csv", rowsToCsv(rHeader, rRows));

  void appendAuditLog({ actionType: "csv.export", summary: "Izvoz CSV" });
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { headers: [], rows: [] };
  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function syncDocumentsSectionFromRecordSelect() {
  const form = refs.vaultVehicleForm;
  const uploadBtn = refs.vaultUploadBtn;
  const fileInput = refs.vaultFileInput;
  const vid = refs.recordVehicleSelect?.value?.trim() || "";
  if (!form) return;
  if (!vid) {
    form.hidden = true;
    if (uploadBtn) uploadBtn.disabled = true;
    if (fileInput) fileInput.disabled = true;
    if (refs.vaultDocumentsBody) refs.vaultDocumentsBody.innerHTML = "";
    if (refs.vaultUploadHint) refs.vaultUploadHint.textContent = "";
    return;
  }
  form.hidden = false;
  if (uploadBtn) uploadBtn.disabled = false;
  if (fileInput) fileInput.disabled = false;
  void renderVaultDocumentsTable();
}

async function renderVaultDocumentsTable() {
  const tbody = refs.vaultDocumentsBody;
  if (!tbody) return;
  const vid = refs.recordVehicleSelect?.value?.trim() || "";
  if (!vid) {
    tbody.innerHTML = "";
    return;
  }
  const db = getFirestoreDb();
  if (!db) {
    tbody.innerHTML = '<tr><td colspan="5">Firestore ni na voljo.</td></tr>';
    return;
  }
  try {
    const snap = await db.collection("vehicle_documents").where("vehicleId", "==", vid).get();
    const rows = [];
    snap.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
    rows.sort((a, b) => {
      const ta = a.uploadedAt?.toMillis ? a.uploadedAt.toMillis() : 0;
      const tb = b.uploadedAt?.toMillis ? b.uploadedAt.toMillis() : 0;
      return tb - ta;
    });
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5">Ni dokumentov.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map((r) => {
        let uploaded = "—";
        if (r.uploadedAt?.toDate) uploaded = formatDateEuropean(dateToIsoLocal(r.uploadedAt.toDate()));
        else if (typeof r.uploadedAt === "string") uploaded = formatDateEuropean(r.uploadedAt.slice(0, 10));
        const exp =
          r.expiresAt && typeof r.expiresAt === "string"
            ? formatDateEuropean(r.expiresAt.slice(0, 10))
            : r.expiresAt?.toDate
              ? formatDateEuropean(dateToIsoLocal(r.expiresAt.toDate()))
              : "—";
        return `<tr>
        <td>${escapeHtml(r.fileName || "")}</td>
        <td>${escapeHtml(r.docType || "—")}</td>
        <td>${escapeHtml(uploaded)}</td>
        <td>${escapeHtml(exp)}</td>
        <td><button type="button" class="secondary btn-small vault-open-btn" data-file-path="${encodeURIComponent(r.filePath || "")}">Odpri</button></td>
      </tr>`;
      })
      .join("");
  } catch (e) {
    console.error(e);
    tbody.innerHTML = '<tr><td colspan="5">Napaka pri branju dokumentov.</td></tr>';
  }
}

async function uploadVaultSelectedFiles() {
  const vid = refs.recordVehicleSelect?.value?.trim() || "";
  const input = refs.vaultFileInput;
  const storage = typeof window !== "undefined" ? window.__carMaintenanceStorage : null;
  if (!vid || !input?.files?.length || !storage) {
    if (refs.vaultUploadHint) refs.vaultUploadHint.textContent = "Izberi vozilo in datoteko.";
    return;
  }
  const db = getFirestoreDb();
  if (!db) return;
  if (refs.vaultUploadHint) refs.vaultUploadHint.textContent = "Nalaganje …";
  try {
    for (const file of input.files) {
      const docId = uid();
      const path = `vehicle-docs/${vid}/${docId}/${file.name}`;
      const ref = storage.ref(path);
      await ref.put(file);
      await db.collection("vehicle_documents").doc(docId).set({
        vehicleId: vid,
        filePath: path,
        fileName: file.name,
        mimeType: file.type || "",
        sizeBytes: file.size,
        docType: "ostalo",
        uploadedAt: firebase.firestore.FieldValue.serverTimestamp(),
        expiresAt: null,
        notes: ""
      });
      await appendAuditLog({
        actionType: "document.upload",
        entityType: "vehicle",
        entityId: vid,
        summary: file.name
      });
    }
    input.value = "";
    if (refs.vaultUploadHint) refs.vaultUploadHint.textContent = "Naloženo.";
    await renderVaultDocumentsTable();
  } catch (e) {
    console.error(e);
    if (refs.vaultUploadHint) refs.vaultUploadHint.textContent = "Napaka pri nalaganju.";
  }
}

async function openVaultDocument(encodedPath) {
  const storage = window.__carMaintenanceStorage;
  const filePath = encodedPath ? decodeURIComponent(encodedPath) : "";
  if (!storage || !filePath) return;
  try {
    const url = await storage.ref(filePath).getDownloadURL();
    window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    console.error(e);
  }
}

function auditLogEntryTsToDate(ts) {
  if (!ts) return null;
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof ts.toDate === "function") return ts.toDate();
  return null;
}

async function loadAndRenderAuditLog() {
  const db = getFirestoreDb();
  if (!db || !refs.auditLogBody) return;
  const fromVal = refs.auditDateFrom?.value;
  const toVal = refs.auditDateTo?.value;
  try {
    const snap = await db.collection("auditLog").orderBy("ts", "desc").limit(1000).get();
    let rows = [];
    snap.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
    const fromD = fromVal ? new Date(`${fromVal}T00:00:00`) : null;
    const toD = toVal ? new Date(`${toVal}T23:59:59.999`) : null;
    rows = rows.filter((r) => {
      const d = auditLogEntryTsToDate(r.ts);
      if (!d) return false;
      if (fromD && d < fromD) return false;
      if (toD && d > toD) return false;
      return true;
    });
    if (!rows.length) {
      refs.auditLogBody.innerHTML = '<tr><td colspan="4">Ni zapisov.</td></tr>';
      if (refs.auditLogEmpty) refs.auditLogEmpty.hidden = true;
      return;
    }
    if (refs.auditLogEmpty) refs.auditLogEmpty.hidden = true;
    refs.auditLogBody.innerHTML = rows
      .map((r) => {
        const d = auditLogEntryTsToDate(r.ts);
        const hh = d
          ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
          : "";
        const timeStr = d ? `${formatDateEuropean(dateToIsoLocal(d))} ${hh}` : "—";
        return `<tr>
        <td>${escapeHtml(timeStr)}</td>
        <td>${escapeHtml(r.action || "")}</td>
        <td>${escapeHtml(r.entity || "")}</td>
        <td>${escapeHtml(r.summary || "")}</td>
      </tr>`;
      })
      .join("");
  } catch (e) {
    console.error(e);
    refs.auditLogBody.innerHTML = `<tr><td colspan="4">Napaka: ${escapeHtml(e.message || String(e))}</td></tr>`;
  }
}

async function requestBackupNow() {
  const db = getFirestoreDb();
  if (!db) return;
  try {
    await db.collection("backup_requests").add({
      requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
      source: "ui"
    });
    await appendAuditLog({ actionType: "backup.request", summary: "Varnostna kopija zdaj" });
    await loadSyncStatusFromFirestore();
    alert("Zahteva za varnostno kopijo poslana. Preveri Firebase Functions.");
  } catch (e) {
    console.error(e);
    alert("Napaka pri zahtevi za kopijo.");
  }
}

async function handleCsvImportFile(file) {
  const text = await file.text();
  const parsed = parseCsv(text);
  const name = file.name.toLowerCase();
  if (name.includes("vehicles")) pendingImportReport = { kind: "vehicles", parsed };
  else if (name.includes("plans")) pendingImportReport = { kind: "plans", parsed };
  else if (name.includes("records")) pendingImportReport = { kind: "records", parsed };
  else {
    pendingImportReport = { kind: "vehicles", parsed };
  }
  if (refs.importPreviewText) {
    refs.importPreviewText.textContent = JSON.stringify(
      { headers: parsed.headers, rows: parsed.rows.slice(0, 8) },
      null,
      2
    );
  }
  if (refs.importPreview) refs.importPreview.hidden = false;
}

async function applyPendingCsvImport() {
  if (!pendingImportReport) return;
  const { kind, parsed } = pendingImportReport;
  const { headers, rows } = parsed;
  const col = (name) => headers.indexOf(name);

  if (kind === "vehicles") {
    const idI = col("id");
    if (idI < 0) throw new Error("Manjka stolpec id");
    for (const row of rows) {
      const id = row[idI];
      if (!id) continue;
      let v = state.vehicles.find((x) => x.id === id);
      if (!v) {
        v = {
          id,
          nickname: "",
          year: new Date().getFullYear(),
          make: "",
          model: "",
          referenceMarketValue: null,
          baseMileage: 0,
          currentMileage: 0,
          vinjetaValidUntilSI: null,
          vinjetaValidUntilAT: null,
          registracijaValidUntil: null,
          status: "active",
          archivedAt: null,
          archivedReason: null
        };
        state.vehicles.push(v);
      }
      const ni = col("nickname");
      const yi = col("year");
      const mi = col("make");
      const modi = col("model");
      const st = col("status");
      const rv = col("referenceMarketValue");
      const bm = col("baseMileage");
      const cm = col("currentMileage");
      if (ni >= 0) v.nickname = row[ni] || v.nickname;
      if (yi >= 0) v.year = Number(row[yi]) || v.year;
      if (mi >= 0) v.make = row[mi] || v.make;
      if (modi >= 0) v.model = row[modi] || v.model;
      if (st >= 0 && row[st]) v.status = row[st] === "archived" ? "archived" : "active";
      if (rv >= 0 && row[rv] !== "") v.referenceMarketValue = Number(row[rv]) || null;
      if (bm >= 0 && row[bm] !== "") v.baseMileage = Number(row[bm]) || 0;
      if (cm >= 0 && row[cm] !== "") v.currentMileage = Number(row[cm]) || 0;
      const recs = state.records.filter((r) => r.vehicleId === v.id);
      v.currentMileage = computeVehicleCurrentMileage(v, recs);
    }
  } else if (kind === "plans") {
    const idI = col("id");
    const vidI = col("vehicleId");
    if (idI < 0 || vidI < 0) throw new Error("Manjkajo stolpci id / vehicleId");
    for (const row of rows) {
      const id = row[idI];
      const vehicleId = row[vidI];
      if (!id || !vehicleId) continue;
      let p = state.plans.find((x) => x.id === id);
      if (!p) {
        p = { id, vehicleId, type: "Mali servis", intervalMiles: null, intervalDays: null, lastServiceDate: null, lastServiceMileage: null, notes: null };
        state.plans.push(p);
      }
      const ti = col("type");
      const im = col("intervalMiles");
      const idd = col("intervalDays");
      const lsd = col("lastServiceDate");
      const lsm = col("lastServiceMileage");
      const no = col("notes");
      if (ti >= 0) p.type = normalizeServiceTypeName(row[ti]);
      if (im >= 0 && row[im] !== "") p.intervalMiles = Number(row[im]) || null;
      if (idd >= 0 && row[idd] !== "") p.intervalDays = Number(row[idd]) || null;
      if (lsd >= 0 && row[lsd]) p.lastServiceDate = row[lsd].slice(0, 10);
      if (lsm >= 0 && row[lsm] !== "") p.lastServiceMileage = Number(row[lsm]) || null;
      if (no >= 0) p.notes = row[no] || null;
    }
  } else if (kind === "records") {
    const idI = col("id");
    const vidI = col("vehicleId");
    if (idI < 0 || vidI < 0) throw new Error("Manjkajo stolpci id / vehicleId");
    for (const row of rows) {
      const id = row[idI];
      const vehicleId = row[vidI];
      if (!id || !vehicleId) continue;
      let r = state.records.find((x) => x.id === id);
      if (!r) {
        r = { id, vehicleId, type: "Mali servis", serviceDate: "", mileageAtService: 0, cost: null, shopName: "", notes: "" };
        state.records.push(r);
      }
      const ti = col("type");
      const sd = col("serviceDate");
      const ms = col("mileageAtService");
      const co = col("cost");
      const sh = col("shopName");
      const no = col("notes");
      if (ti >= 0) r.type = normalizeServiceTypeName(row[ti]);
      if (sd >= 0) r.serviceDate = row[sd].slice(0, 10);
      if (ms >= 0) r.mileageAtService = Number(row[ms]) || 0;
      if (co >= 0 && row[co] !== "") r.cost = Number(row[co]) || null;
      if (sh >= 0) r.shopName = row[sh] || "";
      if (no >= 0) r.notes = row[no] || "";
    }
    state.vehicles.forEach((veh) => {
      const recs = state.records.filter((x) => x.vehicleId === veh.id);
      veh.currentMileage = computeVehicleCurrentMileage(veh, recs);
    });
    state.plans.forEach((pl) => recalculatePlanLastService(pl.vehicleId, pl.type));
  }

  state = migrateState(state);
  await appendAuditLog({ actionType: "csv.import", summary: `Uvoz ${kind}` });
  await saveState();
  pendingImportReport = null;
  if (refs.importPreview) refs.importPreview.hidden = true;
  if (refs.csvImportInput) refs.csvImportInput.value = "";
  renderAll();
}

function renderVehicles() {
  refs.vehicleList.innerHTML = "";
  const active = getActiveVehicles();
  const archived = getArchivedVehicles();

  if (!state.vehicles.length) {
    refs.vehicleList.innerHTML = "<p>Še ni dodanih vozil.</p>";
    if (refs.vehicleArchivedSection) refs.vehicleArchivedSection.hidden = true;
    return;
  }

  if (!active.length) {
    refs.vehicleList.innerHTML = "<p>Ni aktivnih vozil. Dodaj novo vozilo ali obnovi arhivirano.</p>";
  } else {
    active.forEach((vehicle) => {
      const node = refs.vehicleItemTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector(".vehicle-title").textContent = `${vehicle.nickname} - ${vehicle.year} ${vehicle.make} ${vehicle.model}`;
      const base = vehicle.baseMileage != null ? vehicle.baseMileage : vehicle.currentMileage;
      node.querySelector(".vehicle-mileage").textContent = `Trenutni kilometri: ${vehicle.currentMileage.toLocaleString("sl-SI")} (ob vnosu: ${Number(base).toLocaleString("sl-SI")} km)`;
      const editBtn = node.querySelector('[data-action="edit-vehicle"]');
      const archBtn = node.querySelector('[data-action="archive-vehicle"]');
      const delBtn = node.querySelector('[data-action="delete-vehicle"]');
      editBtn.dataset.id = vehicle.id;
      archBtn.dataset.id = vehicle.id;
      delBtn.dataset.id = vehicle.id;
      refs.vehicleList.appendChild(node);
    });
  }

  if (refs.vehicleArchivedSection && refs.vehicleArchivedList) {
    if (archived.length) {
      refs.vehicleArchivedSection.hidden = false;
      refs.vehicleArchivedList.innerHTML = archived
        .map(
          (v) => `
      <article class="vehicle-item">
        <div class="vehicle-item-main">
          <h3 class="vehicle-title">${escapeHtml(v.nickname)} - ${v.year} ${escapeHtml(v.make)} ${escapeHtml(v.model)}</h3>
          <p class="vehicle-mileage">Arhivirano${
            v.archivedAt && typeof v.archivedAt === "string"
              ? ` (${formatDateEuropean(v.archivedAt.slice(0, 10))})`
              : ""
          }</p>
        </div>
        <div class="item-actions">
          <button type="button" class="secondary btn-small" data-action="restore-vehicle" data-id="${escapeHtml(v.id)}">Obnovi</button>
        </div>
      </article>`
        )
        .join("");
    } else {
      refs.vehicleArchivedSection.hidden = true;
      refs.vehicleArchivedList.innerHTML = "";
    }
  }
}

async function archiveVehicleById(vehicleId) {
  const v = state.vehicles.find((x) => x.id === vehicleId);
  if (!v || v.status === "archived") return;
  if (!confirm("Arhivirati to vozilo? Vsi podatki ostanejo shranjeni.")) return;
  v.status = "archived";
  v.archivedAt = dateToIsoLocal(new Date());
  await appendAuditLog({
    actionType: "vehicle.archive",
    entityType: "vehicle",
    entityId: vehicleId,
    summary: v.nickname
  });
  if (filterVehicleId === vehicleId) filterVehicleId = "";
  if (refs.vehicleFormVehicleId.value === vehicleId) cancelVehicleEdit();
  await saveState();
  await logAuditEntry("ARHIVIRANO", "Vozilo", `${v.nickname} – ${v.year} ${v.make} ${v.model}`);
  renderAll();
}

async function restoreVehicleById(vehicleId) {
  const v = state.vehicles.find((x) => x.id === vehicleId);
  if (!v || v.status !== "archived") return;
  v.status = "active";
  v.archivedAt = null;
  v.archivedReason = null;
  await appendAuditLog({
    actionType: "vehicle.restore",
    entityType: "vehicle",
    entityId: vehicleId,
    summary: v.nickname
  });
  await saveState();
  await logAuditEntry("OBNOVLJENO", "Vozilo", `${v.nickname} – ${v.year} ${v.make} ${v.model}`);
  renderAll();
}

function setVehicleEditMode(editing, vehicleId = "") {
  refs.vehicleFormVehicleId.value = vehicleId;
  refs.cancelVehicleEditBtn.hidden = !editing;
  refs.vehicleFormSubmitBtn.textContent = editing ? "Shrani spremembe" : "Dodaj vozilo";
  refs.vehicleFormHeading.textContent = editing ? "Uredi vozilo" : "Dodaj vozilo";
}

function showPanel(panelName) {
  document.querySelectorAll(".panel").forEach((p) => {
    p.classList.toggle("is-active", p.id === `panel-${panelName}`);
  });
  document.querySelectorAll(".rail-link").forEach((b) => {
    const active = b.dataset.panel === panelName;
    b.classList.toggle("is-active", active);
    if (active) {
      const titleEl = document.getElementById("pageTitle");
      const leadEl = document.getElementById("pageLead");
      if (titleEl && b.dataset.title) titleEl.textContent = b.dataset.title;
      if (leadEl && b.dataset.lead != null) leadEl.textContent = b.dataset.lead;
    }
  });
  if (panelName === "audit") {
    void loadAndRenderAuditLog();
  }
}

function initPanelNav() {
  document.querySelectorAll(".rail-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.panel) showPanel(btn.dataset.panel);
    });
  });
}

function startEditVehicle(vehicleId) {
  showPanel("vehicles");
  const vehicle = state.vehicles.find((v) => v.id === vehicleId);
  if (!vehicle) return;
  const f = refs.vehicleForm;
  f.querySelector('[name="nickname"]').value = vehicle.nickname;
  f.querySelector('[name="year"]').value = vehicle.year;
  f.querySelector('[name="make"]').value = vehicle.make;
  f.querySelector('[name="model"]').value = vehicle.model;
  const base = vehicle.baseMileage != null ? vehicle.baseMileage : vehicle.currentMileage;
  f.querySelector('[name="currentMileage"]').value = base;
  const refEl = f.querySelector('[name="referenceMarketValue"]');
  if (refEl) {
    refEl.value = vehicle.referenceMarketValue != null ? vehicle.referenceMarketValue : "";
  }
  setVehicleEditMode(true, vehicleId);
  f.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function cancelVehicleEdit() {
  refs.vehicleForm.reset();
  setVehicleEditMode(false);
}

async function deleteVehicleById(vehicleId) {
  if (!confirm("Ali res želiš izbrisati to vozilo? Izbrisani bodo tudi vsi plani in servisni zapisi za to vozilo.")) {
    return;
  }
  const v = state.vehicles.find((x) => x.id === vehicleId);
  state.vehicles = state.vehicles.filter((x) => x.id !== vehicleId);
  state.plans = state.plans.filter((p) => p.vehicleId !== vehicleId);
  state.records = state.records.filter((r) => r.vehicleId !== vehicleId);
  if (filterVehicleId === vehicleId) {
    filterVehicleId = "";
  }
  if (refs.vehicleFormVehicleId.value === vehicleId) {
    cancelVehicleEdit();
  }
  hidePlanEdit();
  await saveState();
  if (v) {
    await logAuditEntry("IZBRISANO", "Vozilo", `${v.nickname} – ${v.year} ${v.make} ${v.model}`);
  }
  renderAll();
}

function renderDueDashboard() {
  refs.dueDashboard.innerHTML = "";
  const allowedIds = new Set(getFilteredVehicleIds());
  const plans = state.plans.filter((p) => allowedIds.has(p.vehicleId));

  if (!plans.length) {
    refs.dueDashboard.innerHTML =
      filterVehicleId && state.plans.length
        ? "<p>Za to vozilo ni planov vzdrževanja.</p>"
        : "<p>Še ni planov vzdrževanja.</p>";
    return;
  }

  plans.forEach((plan) => {
    const vehicle = state.vehicles.find((v) => v.id === plan.vehicleId);
    if (!vehicle) return;
    const status = statusForPlan(plan, vehicle);
    const item = document.createElement("article");
    item.className = "due-item";
    item.innerHTML = `
      <div class="due-item-main">
        <p><strong>${escapeHtml(vehicle.nickname)}</strong> – ${escapeHtml(plan.type)}</p>
        <p><span class="status ${status}">${statusLabel(status)}</span></p>
        <p>Zadnji servis: ${plan.lastServiceDate ? formatDateEuropean(plan.lastServiceDate) : "ni podatka"} pri ${plan.lastServiceMileage ?? "ni podatka"} km</p>
        <p>Interval: ${plan.intervalMiles ?? "–"} km / ${plan.intervalDays ?? "–"} dni</p>
        ${plan.notes ? `<p class="hint">Pripomba: ${escapeHtml(plan.notes)}</p>` : ""}
      </div>
      <div class="item-actions">
        <button type="button" class="secondary btn-small" data-action="edit-plan" data-id="${plan.id}">Uredi</button>
        <button type="button" class="danger btn-small" data-action="delete-plan" data-id="${plan.id}">Izbriši</button>
      </div>
    `;
    refs.dueDashboard.appendChild(item);
  });
}

function getRecordsForFilter() {
  const allowedIds = new Set(getFilteredVehicleIds());
  return state.records.filter((r) => allowedIds.has(r.vehicleId));
}

function renderHistory() {
  refs.historyList.innerHTML = "";
  const list = getRecordsForFilter();

  if (!list.length) {
    refs.historyList.innerHTML =
      filterVehicleId && state.records.length
        ? "<p>Za to vozilo ni servisnih zapisov.</p>"
        : "<p>Še ni servisnih zapisov.</p>";
    return;
  }

  const sorted = [...list].sort((a, b) => b.serviceDate.localeCompare(a.serviceDate));
  if (expandedHistoryRecordId && !sorted.some((r) => r.id === expandedHistoryRecordId)) {
    expandedHistoryRecordId = null;
  }

  const rows = sorted
    .map((record) => {
    const vehicle = state.vehicles.find((v) => v.id === record.vehicleId);
      const isOpen = record.id === expandedHistoryRecordId;
      const vehicleName = vehicle ? escapeHtml(vehicle.nickname) : "Neznano vozilo";
      const serviceDate = formatDateEuropean(record.serviceDate);
      const mileage = Number(record.mileageAtService).toLocaleString("sl-SI");
      const costLabel = record.cost != null ? `${Number(record.cost).toFixed(2)} EUR` : "ni podatka";
      const shopLabel = record.shopName ? escapeHtml(record.shopName) : "ni podatka";
      const notesLabel = record.notes ? escapeHtml(record.notes) : "ni podatka";
      return `
        <tr class="history-accordion-row${isOpen ? " is-open" : ""}" data-record-id="${record.id}">
          <td>${escapeHtml(serviceDate)}</td>
          <td>${vehicleName}</td>
          <td>${escapeHtml(record.type)}</td>
          <td>${mileage}</td>
          <td class="history-accordion-toggle-cell"><span class="history-accordion-toggle" aria-hidden="true">▼</span></td>
        </tr>
        <tr class="history-accordion-details-row${isOpen ? " is-open" : ""}"${isOpen ? "" : " hidden"}>
          <td colspan="5">
            <div class="history-accordion-details">
              <p><strong>Cena (EUR):</strong> ${escapeHtml(costLabel)}</p>
              <p><strong>Servis:</strong> ${shopLabel}</p>
              <p><strong>Opombe:</strong> ${notesLabel}</p>
              <div class="item-actions">
                <button type="button" class="secondary btn-small" data-action="edit-record" data-id="${record.id}">Uredi</button>
                <button type="button" class="danger btn-small" data-action="delete-record" data-id="${record.id}">Izbriši</button>
              </div>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  refs.historyList.innerHTML = `
    <div class="table-scroll">
      <table class="vinjeta-table history-accordion-table">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Vozilo</th>
            <th>Vrsta servisa</th>
            <th>Kilometri</th>
            <th class="history-accordion-toggle-cell">▼</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function recalculatePlanLastService(vehicleId, type) {
  const plan = state.plans.find((p) => p.vehicleId === vehicleId && p.type === type);
  if (!plan) return;
  const recs = state.records.filter((r) => r.vehicleId === vehicleId && r.type === type);
  if (!recs.length) {
    plan.lastServiceDate = null;
    plan.lastServiceMileage = null;
    return;
  }
  const latest = recs.reduce((best, r) => {
    if (!best) return r;
    if (r.serviceDate > best.serviceDate) return r;
    if (r.serviceDate === best.serviceDate && r.mileageAtService > best.mileageAtService) return r;
    return best;
  }, null);
  plan.lastServiceDate = latest.serviceDate;
  plan.lastServiceMileage = latest.mileageAtService;
}

function hidePlanEdit() {
  refs.planEditCard.hidden = true;
  refs.planEditForm.reset();
  refs.planEditPlanId.value = "";
}

function showPlanEdit(planId) {
  const plan = state.plans.find((p) => p.id === planId);
  if (!plan) return;
  showPanel("overview");
  const vehicle = state.vehicles.find((v) => v.id === plan.vehicleId);
  refs.planEditCard.hidden = false;
  refs.planEditPlanId.value = plan.id;
  refs.planEditSummary.textContent = vehicle
    ? `${vehicle.nickname} – ${plan.type}`
    : plan.type;
  refs.planEditIntervalMiles.value = plan.intervalMiles ?? "";
  refs.planEditIntervalDays.value = plan.intervalDays ?? "";
  refs.planEditLastDate.value = plan.lastServiceDate ? formatDateEuropean(plan.lastServiceDate) : "";
  refs.planEditLastMileage.value = plan.lastServiceMileage ?? "";
  const planEditNotes = document.getElementById("planEditNotes");
  if (planEditNotes) planEditNotes.value = plan.notes || "";
  refs.planEditCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setRecordEditMode(editing, recordId = "") {
  refs.recordFormRecordId.value = recordId;
  refs.cancelRecordEditBtn.hidden = !editing;
  refs.recordFormSubmitBtn.textContent = editing ? "Shrani spremembe" : "Dodaj zapis";
}

function startEditRecord(recordId) {
  const record = state.records.find((r) => r.id === recordId);
  if (!record) return;
  showPanel("records");
  refs.recordVehicleSelect.value = record.vehicleId;
  refs.recordTypeSelect.value = record.type;
  refs.recordForm.querySelector('[name="serviceDate"]').value = formatDateEuropean(record.serviceDate);
  refs.recordForm.querySelector('[name="mileageAtService"]').value = record.mileageAtService;
  const costEl = refs.recordForm.querySelector('[name="cost"]');
  if (costEl) costEl.value = record.cost != null ? record.cost : "";
  refs.recordForm.querySelector('[name="shopName"]').value = record.shopName || "";
  refs.recordForm.querySelector('[name="notes"]').value = record.notes || "";
  setRecordEditMode(true, recordId);
  syncDocumentsSectionFromRecordSelect();
  refs.recordForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function cancelRecordEdit() {
  refs.recordForm.reset();
  setRecordEditMode(false);
  syncDocumentsSectionFromRecordSelect();
}

function getChartThemeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    text: s.getPropertyValue("--text").trim() || "#14161a",
    grid: s.getPropertyValue("--border").trim() || "#e8eaef",
    bar1: s.getPropertyValue("--chart-bar-1").trim() || "#0f766e",
    bar2: s.getPropertyValue("--chart-bar-2").trim() || "#6366f1"
  };
}

function updateOverviewChart() {
  const canvas = document.getElementById("valueChart");
  const hint = document.getElementById("chartHint");
  const disc = document.getElementById("chartDisclaimer");
  const avto = document.getElementById("avtoNetLink");
  const mob = document.getElementById("mobileDeLink");
  if (!canvas || typeof Chart === "undefined") return;

  if (valueChartInstance) {
    valueChartInstance.destroy();
    valueChartInstance = null;
  }

  if (!filterVehicleId) {
    if (hint) {
      hint.textContent =
        "Izberi vozilo zgoraj za graf ocene vrednosti in skupnih stroškov servisa.";
    }
    if (disc) disc.textContent = "";
    if (avto) {
      avto.href = "https://www.avto.net/";
      avto.textContent = "Odpri avto.net";
    }
    if (mob) {
      mob.href = "https://www.mobile.de/";
      mob.textContent = "Odpri mobile.de";
    }
    return;
  }

  const vehicle = state.vehicles.find((v) => v.id === filterVehicleId);
  if (!vehicle) return;

  const marketVal = getDisplayedMarketValueEur(vehicle);
  const repairs = getTotalRepairCostEur(filterVehicleId);
  const colors = getChartThemeColors();

  if (hint) {
    hint.textContent = `${vehicle.nickname} · ${vehicle.year} ${vehicle.make} ${vehicle.model}`;
  }
  if (disc) {
    disc.textContent = vehicle.referenceMarketValue
      ? "Vrednost: tvoja referenčna ocena (EUR). Skupaj servis: seštevek vnesenih zneskov pri zapisih."
      : "Vrednost: informativna ocena po letniku in kilometrih (brez povezave z avto.net). Za realne cene uporabi povezavi spodaj.";
  }

  if (avto) {
    avto.href = buildAvtoNetSearchUrl(vehicle);
    avto.textContent = "Primerjaj podobne oglase na avto.net";
  }
  if (mob) {
    mob.href = buildMobileDeSearchUrl(vehicle);
    mob.textContent = "Iskanje na mobile.de";
  }

  const ctx = canvas.getContext("2d");
  valueChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Ocena vrednosti vozila (EUR)", "Skupaj za servis / popravila (EUR)"],
      datasets: [
        {
          data: [marketVal, Math.round(repairs * 100) / 100],
          backgroundColor: [colors.bar1, colors.bar2],
          borderRadius: 8,
          borderSkipped: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = Number(ctx.raw);
              const dec = ctx.dataIndex === 1 ? 2 : 0;
              return ` ${v.toLocaleString("sl-SI", { minimumFractionDigits: dec, maximumFractionDigits: dec })} EUR`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: colors.text, maxRotation: 45, minRotation: 0, font: { size: 11 } },
          grid: { display: false }
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: colors.text,
            callback(value) {
              return Number(value).toLocaleString("sl-SI");
            }
          },
          grid: { color: colors.grid }
        }
      }
    }
  });
}

/**
 * Povečava celotne strani (CSS zoom na korenskem elementu html). Shranjeno v localStorage.
 */
function setZoomFactor(factor) {
  const f = parseFloat(String(factor));
  if (Number.isNaN(f) || f < 0.5 || f > 3) return;
  const use = ZOOM_LEVELS.find((x) => Math.abs(x - f) < 0.001) ?? 1;
  if (use === 1) {
    document.documentElement.style.removeProperty("zoom");
  } else {
    document.documentElement.style.zoom = String(use);
  }
  localStorage.setItem(ZOOM_KEY, String(use));
  const sel = document.getElementById("zoomSelect");
  if (sel) sel.value = String(use);
}

function initZoom() {
  const raw = localStorage.getItem(ZOOM_KEY);
  let v = 1;
  if (raw != null) {
    const parsed = parseFloat(raw);
    if (!Number.isNaN(parsed)) {
      v = ZOOM_LEVELS.find((x) => Math.abs(x - parsed) < 0.001) ?? 1;
    }
  }
  if (v === 1) {
    document.documentElement.style.removeProperty("zoom");
  } else {
    document.documentElement.style.zoom = String(v);
  }
  const sel = document.getElementById("zoomSelect");
  if (sel) sel.value = String(v);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved === "dark" || saved === "light" ? saved : prefersDark ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeToggle");
  if (btn) {
    btn.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    const label = btn.querySelector(".theme-toggle__label");
    if (label) label.textContent = theme === "dark" ? "Svetlo ozadje" : "Temno ozadje";
  }
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = cur === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  document.documentElement.setAttribute("data-theme", next);
  const btn = document.getElementById("themeToggle");
  if (btn) {
    btn.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
    const label = btn.querySelector(".theme-toggle__label");
    if (label) label.textContent = next === "dark" ? "Svetlo ozadje" : "Temno ozadje";
  }
  updateOverviewChart();
}

function renderAll() {
  refreshSelects();
  renderVehicles();
  renderDueSoonCard();
  renderDueDashboard();
  renderHistory();
  updateOverviewChart();
  refreshVinjetaPanelUI();
  renderVinjetaEvidenceBlocks();
  syncDocumentsSectionFromRecordSelect();
}

refs.filterVehicleSelect.addEventListener("change", () => {
  filterVehicleId = refs.filterVehicleSelect.value || "";
  renderDueDashboard();
  renderHistory();
  updateOverviewChart();
  renderVinjetaEvidenceBlocks();
});

if (refs.themeToggle) {
  refs.themeToggle.addEventListener("click", toggleTheme);
}

if (refs.zoomSelect) {
  refs.zoomSelect.addEventListener("change", () => {
    setZoomFactor(refs.zoomSelect.value);
  });
}

if (refs.vinjetaVehicleSelect && refs.vinjetaOpenBtn) {
  refs.vinjetaVehicleSelect.addEventListener("change", () => {
    lastVinjetaVehicleId = refs.vinjetaVehicleSelect.value || null;
    refs.vinjetaOpenBtn.disabled = !refs.vinjetaVehicleSelect.value;
  });
}

if (refs.vinjetaOpenBtn) {
  refs.vinjetaOpenBtn.addEventListener("click", () => openVinjetaModal());
}

if (refs.vinjetaPanelVehicleSelect) {
  refs.vinjetaPanelVehicleSelect.addEventListener("change", () => applyVinjetaPanelSelection());
}

if (refs.vinjetaPanelSaveBtn) {
  refs.vinjetaPanelSaveBtn.addEventListener("click", () => void saveVinjetaPanelForm());
}

if (refs.vinjetaModalClose) {
  refs.vinjetaModalClose.addEventListener("click", () => closeVinjetaModal());
}

if (refs.vinjetaModalBackdrop) {
  refs.vinjetaModalBackdrop.addEventListener("click", () => closeVinjetaModal());
}

if (refs.vinjetaIframe) {
  refs.vinjetaIframe.addEventListener("load", () => {
    const url = refs.vinjetaIframe.src || "";
    if (!url || url.startsWith("about:")) return;
    clearTimeout(vinjetaLoadTimeoutId);
    vinjetaLoadTimeoutId = null;
    if (refs.vinjetaModal && !refs.vinjetaModal.hidden && refs.vinjetaLoader) {
      refs.vinjetaLoader.hidden = true;
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && refs.vinjetaModal && !refs.vinjetaModal.hidden) {
    closeVinjetaModal();
  }
});

refs.dueDashboard.addEventListener("click", (e) => {
  void (async () => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    const action = btn.getAttribute("data-action");
    if (action === "edit-plan") showPlanEdit(id);
    if (action === "delete-plan") {
      if (!confirm("Ali res želiš izbrisati ta plan vzdrževanja?")) return;
      const plan = state.plans.find((p) => p.id === id);
      const vehicle = plan ? state.vehicles.find((x) => x.id === plan.vehicleId) : null;
      state.plans = state.plans.filter((p) => p.id !== id);
      hidePlanEdit();
      await saveState();
      if (plan && vehicle) {
        await logAuditEntry("IZBRISANO", "Plan", `${vehicle.nickname} – ${plan.type}`);
      }
      renderAll();
    }
  })();
});

refs.historyList.addEventListener("click", (e) => {
  void (async () => {
    const btn = e.target.closest("[data-action]");
    if (btn) {
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      if (action === "edit-record") {
        startEditRecord(id);
        return;
      }
      if (action === "delete-record") {
        if (!confirm("Ali res želiš izbrisati ta servisni zapis?")) return;
        const rec = state.records.find((r) => r.id === id);
        const vehicle = rec ? state.vehicles.find((x) => x.id === rec.vehicleId) : null;
        state.records = state.records.filter((r) => r.id !== id);
        if (rec) {
          recalculatePlanLastService(rec.vehicleId, rec.type);
          recalculateVehicleMileage(rec.vehicleId);
        }
        if (refs.recordFormRecordId.value === id) cancelRecordEdit();
        await saveState();
        if (rec && vehicle) {
          await logAuditEntry("IZBRISANO", "Servisni zapis", `${vehicle.nickname} – ${rec.type}`);
        }
        renderAll();
        return;
      }
    }

    const row = e.target.closest("tr.history-accordion-row");
    if (!row) return;
    const recordId = row.getAttribute("data-record-id");
    if (!recordId) return;
    expandedHistoryRecordId = expandedHistoryRecordId === recordId ? null : recordId;
    renderHistory();
  })();
});

refs.planEditForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    const planId = refs.planEditPlanId.value;
    const plan = state.plans.find((p) => p.id === planId);
    if (!plan) return;
    plan.intervalMiles = refs.planEditIntervalMiles.value ? Number(refs.planEditIntervalMiles.value) : null;
    plan.intervalDays = refs.planEditIntervalDays.value ? Number(refs.planEditIntervalDays.value) : null;
    const dateRaw = refs.planEditLastDate.value.trim();
    if (dateRaw) {
      const parsed = parseServiceDateInput(dateRaw);
      if (!parsed) {
        alert("Neveljaven datum zadnjega servisa. Uporabi obliko dd/mm/yyyy.");
        return;
      }
      plan.lastServiceDate = parsed;
    } else {
      plan.lastServiceDate = null;
    }
    plan.lastServiceMileage = refs.planEditLastMileage.value ? Number(refs.planEditLastMileage.value) : null;
    const planEditNotes = document.getElementById("planEditNotes");
    plan.notes = planEditNotes && planEditNotes.value.trim() ? planEditNotes.value.trim() : null;
    await saveState();
    const veh = state.vehicles.find((x) => x.id === plan.vehicleId);
    if (veh) {
      await logAuditEntry("UREJENO", "Plan", `${veh.nickname} – ${plan.type}`);
    }
    hidePlanEdit();
    renderAll();
  })();
});

refs.cancelPlanEditBtn.addEventListener("click", hidePlanEdit);

refs.cancelRecordEditBtn.addEventListener("click", () => {
  cancelRecordEdit();
});

refs.cancelVehicleEditBtn.addEventListener("click", () => {
  cancelVehicleEdit();
});

refs.vehicleList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const action = btn.getAttribute("data-action");
  if (action === "edit-vehicle") startEditVehicle(id);
  if (action === "delete-vehicle") void deleteVehicleById(id);
  if (action === "archive-vehicle") void archiveVehicleById(id);
});

if (refs.vehicleArchivedList) {
  refs.vehicleArchivedList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.getAttribute("data-action") === "restore-vehicle") {
      void restoreVehicleById(btn.getAttribute("data-id"));
    }
  });
}

refs.vehicleForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    const form = new FormData(refs.vehicleForm);
    const existingId = String(form.get("vehicleId") || "").trim();

    if (existingId) {
      const vehicle = state.vehicles.find((v) => v.id === existingId);
      if (!vehicle) return;
      vehicle.nickname = String(form.get("nickname"));
      vehicle.year = Number(form.get("year"));
      vehicle.make = String(form.get("make"));
      vehicle.model = String(form.get("model"));
      vehicle.referenceMarketValue = form.get("referenceMarketValue")
        ? Number(form.get("referenceMarketValue"))
        : null;
      vehicle.baseMileage = Number(form.get("currentMileage"));
      recalculateVehicleMileage(vehicle.id);
      await saveState();
      await logAuditEntry(
        "UREJENO",
        "Vozilo",
        `${vehicle.nickname} – ${vehicle.year} ${vehicle.make} ${vehicle.model}`
      );
      cancelVehicleEdit();
      renderAll();
      return;
    }

    const km = Number(form.get("currentMileage"));
    const vehicle = {
      id: uid(),
      nickname: String(form.get("nickname")),
      year: Number(form.get("year")),
      make: String(form.get("make")),
      model: String(form.get("model")),
      referenceMarketValue: form.get("referenceMarketValue") ? Number(form.get("referenceMarketValue")) : null,
      baseMileage: km,
      currentMileage: km,
      vinjetaValidUntilSI: null,
      vinjetaValidUntilAT: null,
      registracijaValidUntil: null,
      status: "active",
      archivedAt: null,
      archivedReason: null
    };
    state.vehicles.push(vehicle);
    recalculateVehicleMileage(vehicle.id);
    await saveState();
    await logAuditEntry("DODANO", "Vozilo", `${vehicle.nickname} – ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
    refs.vehicleForm.reset();
    setVehicleEditMode(false);
    renderAll();
  })();
});

refs.planForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    const form = new FormData(refs.planForm);
    const typeName = normalizeServiceTypeName(String(form.get("type")));
    const plan = {
      id: uid(),
      vehicleId: String(form.get("vehicleId")),
      type: typeName,
      intervalMiles: form.get("intervalMiles") ? Number(form.get("intervalMiles")) : null,
      intervalDays: form.get("intervalDays") ? Number(form.get("intervalDays")) : null,
      lastServiceDate: null,
      lastServiceMileage: null,
      notes: String(form.get("planNotes") || "").trim() || null
    };
    const dup = state.plans.some((p) => p.vehicleId === plan.vehicleId && p.type === plan.type);
    if (dup) {
      alert("Za to vozilo že obstaja plan te vrste servisa.");
      return;
    }
    state.plans.push(plan);
    await saveState();
    const veh = state.vehicles.find((x) => x.id === plan.vehicleId);
    if (veh) {
      await logAuditEntry("DODANO", "Plan", `${veh.nickname} – ${plan.type}`);
    }
    refs.planForm.reset();
    renderAll();
  })();
});

refs.recordForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    const form = new FormData(refs.recordForm);
    const typeName = normalizeServiceTypeName(String(form.get("type")));
    const recordId = String(form.get("recordId") || "").trim();

    const dateIso = parseServiceDateInput(String(form.get("serviceDate") || ""));
    if (!dateIso) {
      alert("Vnesi veljaven datum v evropski obliki: dd/mm/yyyy (npr. 15/03/2026).");
      return;
    }

    const payload = {
      vehicleId: String(form.get("vehicleId")),
      type: typeName,
      serviceDate: dateIso,
      mileageAtService: Number(form.get("mileageAtService")),
      cost: form.get("cost") ? Number(form.get("cost")) : null,
      shopName: String(form.get("shopName") || ""),
      notes: String(form.get("notes") || "")
    };

    if (recordId) {
      const existing = state.records.find((r) => r.id === recordId);
      if (!existing) return;
      const oldVehicle = existing.vehicleId;
      const oldType = existing.type;
      Object.assign(existing, payload);
      recalculatePlanLastService(oldVehicle, oldType);
      recalculatePlanLastService(existing.vehicleId, existing.type);
      recalculateVehicleMileage(oldVehicle);
      if (existing.vehicleId !== oldVehicle) {
        recalculateVehicleMileage(existing.vehicleId);
      }
      await saveState();
      const vehEd = state.vehicles.find((x) => x.id === existing.vehicleId);
      if (vehEd) {
        await logAuditEntry(
          "UREJENO",
          "Servisni zapis",
          `${vehEd.nickname} – ${existing.type} – ${formatDateEuropean(existing.serviceDate)}`
        );
      }
      cancelRecordEdit();
      renderAll();
      return;
    }

    const record = {
      id: uid(),
      ...payload
    };
    state.records.push(record);

    recalculateVehicleMileage(record.vehicleId);

    const maybePlan = state.plans.find(
      (p) => p.vehicleId === record.vehicleId && p.type === record.type
    );
    if (maybePlan) {
      maybePlan.lastServiceDate = record.serviceDate;
      maybePlan.lastServiceMileage = record.mileageAtService;
    }

    await saveState();
    const vehNew = state.vehicles.find((x) => x.id === record.vehicleId);
    if (vehNew) {
      await logAuditEntry(
        "DODANO",
        "Servisni zapis",
        `${vehNew.nickname} – ${record.type} – ${formatDateEuropean(record.serviceDate)}`
      );
    }
    refs.recordForm.reset();
    setRecordEditMode(false);
    renderAll();
  })();
});

if (refs.recordVehicleSelect) {
  refs.recordVehicleSelect.addEventListener("change", () => syncDocumentsSectionFromRecordSelect());
}
if (refs.vaultUploadBtn) {
  refs.vaultUploadBtn.addEventListener("click", () => void uploadVaultSelectedFiles());
}
if (refs.vaultDocumentsBody) {
  refs.vaultDocumentsBody.addEventListener("click", (e) => {
    const btn = e.target.closest(".vault-open-btn");
    if (!btn) return;
    const p = btn.getAttribute("data-file-path");
    if (p) void openVaultDocument(p);
  });
}
if (refs.auditApplyFilterBtn) {
  refs.auditApplyFilterBtn.addEventListener("click", () => void loadAndRenderAuditLog());
}
if (refs.auditQuickRange) {
  refs.auditQuickRange.addEventListener("change", () => {
    const quick = refs.auditQuickRange.value;
    if (!quick) return;
    const days = Number(quick);
    if (!Number.isFinite(days) || days <= 0) return;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days);
    const y = start.getFullYear();
    const m = String(start.getMonth() + 1).padStart(2, "0");
    const day = String(start.getDate()).padStart(2, "0");
    if (refs.auditDateFrom) refs.auditDateFrom.value = `${y}-${m}-${day}`;
    if (refs.auditDateTo) refs.auditDateTo.value = "";
    void loadAndRenderAuditLog();
  });
}
if (refs.btnExportCsv) {
  refs.btnExportCsv.addEventListener("click", () => exportAllCsv());
}
if (refs.btnImportCsvTrigger && refs.csvImportInput) {
  refs.btnImportCsvTrigger.addEventListener("click", () => refs.csvImportInput.click());
}
if (refs.csvImportInput) {
  refs.csvImportInput.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) void handleCsvImportFile(f);
  });
}
if (refs.btnImportApply) {
  refs.btnImportApply.addEventListener("click", () => {
    void applyPendingCsvImport().catch((err) => alert(err.message || String(err)));
  });
}
if (refs.btnImportCancel) {
  refs.btnImportCancel.addEventListener("click", () => {
    pendingImportReport = null;
    if (refs.importPreview) refs.importPreview.hidden = true;
    if (refs.csvImportInput) refs.csvImportInput.value = "";
  });
}
if (refs.btnBackupNow) {
  refs.btnBackupNow.addEventListener("click", () => void requestBackupNow());
}

initTheme();
initZoom();
initPanelNav();
void loadStateFromFirestore().then(() => renderAll());
