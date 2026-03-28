import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import admin from "firebase-admin";

admin.initializeApp();

const db = admin.firestore();

const EMAIL_API_KEY = defineSecret("EMAIL_API_KEY");
const EMAIL_FROM = defineSecret("EMAIL_FROM");
const EMAIL_TO = defineSecret("EMAIL_TO");
const EMAIL_PROVIDER = defineSecret("EMAIL_PROVIDER");

function toIsoDate(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (typeof value.toDate === "function") {
    const d = value.toDate();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return null;
}

function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

function dueBucket(days) {
  if (days == null) return null;
  if (days < 0) return "overdue";
  if (days <= 30) return "d30";
  if (days <= 60) return "d60";
  if (days <= 90) return "d90";
  return null;
}

async function appendAuditLogServer(payload) {
  await db.collection("audit_logs").add({
    ts: admin.firestore.FieldValue.serverTimestamp(),
    actorType: "server",
    actorId: "cloud-functions",
    actionType: payload.actionType || "system.event",
    entityType: payload.entityType || null,
    entityId: payload.entityId || null,
    summary: payload.summary || "",
    meta: payload.meta || null
  });
}

export const createAuditLog = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  try {
    await appendAuditLogServer(req.body || {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Failed to append audit log" });
  }
});

async function createSnapshot(source) {
  const [vehicles, plans, records, vinjetas] = await Promise.all([
    db.collection("vehicles").get(),
    db.collection("plans").get(),
    db.collection("records").get(),
    db.collection("vinjetas").get()
  ]);
  const payload = {
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    source,
    counts: {
      vehicles: vehicles.size,
      plans: plans.size,
      records: records.size,
      vinjetas: vinjetas.size
    },
    vehicles: vehicles.docs.map((d) => ({ id: d.id, ...d.data() })),
    plans: plans.docs.map((d) => ({ id: d.id, ...d.data() })),
    records: records.docs.map((d) => ({ id: d.id, ...d.data() })),
    vinjetas: vinjetas.docs.map((d) => ({ id: d.id, ...d.data() }))
  };
  const snapRef = await db.collection("backup_snapshots").add(payload);
  await db.collection("sync_status").doc("global").set(
    {
      lastBackupAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSuccessfulSyncAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  await appendAuditLogServer({
    actionType: "backup.snapshot",
    entityType: "backup",
    entityId: snapRef.id,
    summary: `Snapshot from ${source}`
  });
  return snapRef.id;
}

export const runBackupNow = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  try {
    const id = await createSnapshot("http");
    res.json({ ok: true, snapshotId: id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Backup failed" });
  }
});

export const onBackupRequest = onDocumentCreated("backup_requests/{id}", async () => {
  try {
    await createSnapshot("request");
  } catch (e) {
    console.error(e);
    await appendAuditLogServer({
      actionType: "backup.error",
      summary: "Snapshot request failed",
      meta: { message: e.message || String(e) }
    });
  }
});

function buildReminderItems(vehicles, plans) {
  const activeVehicles = vehicles.filter((v) => v.status !== "archived");
  const planByVehicle = new Map();
  for (const p of plans) {
    if (!planByVehicle.has(p.vehicleId)) planByVehicle.set(p.vehicleId, []);
    planByVehicle.get(p.vehicleId).push(p);
  }

  const items = [];
  for (const v of activeVehicles) {
    const list = planByVehicle.get(v.id) || [];
    for (const p of list) {
      const intervalDays = Number(p.intervalDays) || null;
      const intervalMiles = Number(p.intervalMiles) || null;
      const currentMileage = Number(v.currentMileage) || 0;
      const lastMileage = Number(p.lastServiceMileage);

      if (intervalMiles && Number.isFinite(lastMileage)) {
        const dueAt = lastMileage + intervalMiles;
        if (currentMileage >= dueAt) {
          items.push({
            key: `${v.id}:plan-km:${p.id || p.type}`,
            label: `${v.nickname} - ${p.type} (km zapadlo)`
          });
        }
      }

      const lastServiceIso = toIsoDate(p.lastServiceDate);
      if (intervalDays && lastServiceIso) {
        const last = new Date(`${lastServiceIso}T00:00:00`);
        const due = new Date(last);
        due.setDate(due.getDate() + intervalDays);
        const dueIso = toIsoDate(due.toISOString());
        const bucket = dueBucket(daysUntil(dueIso));
        if (bucket) {
          items.push({
            key: `${v.id}:plan-day:${p.id || p.type}:${bucket}`,
            label: `${v.nickname} - ${p.type} (${dueIso})`
          });
        }
      }
    }

    const si = toIsoDate(v.vinjetaValidUntilSI);
    const at = toIsoDate(v.vinjetaValidUntilAT);
    const bSi = dueBucket(daysUntil(si));
    const bAt = dueBucket(daysUntil(at));
    if (bSi) items.push({ key: `${v.id}:vinjeta-si:${bSi}`, label: `${v.nickname} - Vinjeta SI (${si})` });
    if (bAt) items.push({ key: `${v.id}:vinjeta-at:${bAt}`, label: `${v.nickname} - Vinjeta AT (${at})` });
  }
  return items;
}

async function sendEmailLines(lines) {
  const provider = EMAIL_PROVIDER.value() || "resend";
  const apiKey = EMAIL_API_KEY.value();
  const from = EMAIL_FROM.value();
  const to = EMAIL_TO.value();
  if (!apiKey || !from || !to) {
    throw new Error("EMAIL_API_KEY / EMAIL_FROM / EMAIL_TO secrets are missing");
  }

  if (provider === "resend") {
    const body = {
      from,
      to: [to],
      subject: "Evidenca vozil - opomniki",
      text: lines.join("\n")
    };
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Resend error: ${txt}`);
    }
    return;
  }

  throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
}

export const sendDueRemindersEmail = onSchedule(
  {
    schedule: "every day 07:00",
    timeZone: "Europe/Ljubljana",
    secrets: [EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM, EMAIL_TO]
  },
  async () => {
    try {
      const [vSnap, pSnap] = await Promise.all([
        db.collection("vehicles").get(),
        db.collection("plans").get()
      ]);
      const vehicles = vSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const plans = pSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const allItems = buildReminderItems(vehicles, plans);

      const today = new Date().toISOString().slice(0, 10);
      const lines = [];
      for (const item of allItems) {
        const docId = `${today}:${item.key}`.replace(/[^\w:-]/g, "_");
        const docRef = db.collection("reminder_jobs").doc(docId);
        const exists = await docRef.get();
        if (exists.exists) continue;
        await docRef.set({
          runDate: today,
          itemKey: item.key,
          status: "queued",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        lines.push(`- ${item.label}`);
      }

      if (!lines.length) {
        await db.collection("sync_status").doc("global").set(
          {
            lastReminderRunAt: admin.firestore.FieldValue.serverTimestamp(),
            lastReminderRunStatus: "no-items"
          },
          { merge: true }
        );
        return;
      }

      await sendEmailLines(lines);
      await db.collection("sync_status").doc("global").set(
        {
          lastReminderRunAt: admin.firestore.FieldValue.serverTimestamp(),
          lastReminderRunStatus: "sent"
        },
        { merge: true }
      );
      await appendAuditLogServer({
        actionType: "reminder.email.sent",
        summary: `Sent ${lines.length} reminder items`
      });
    } catch (e) {
      console.error(e);
      await db.collection("sync_status").doc("global").set(
        {
          lastReminderRunAt: admin.firestore.FieldValue.serverTimestamp(),
          lastReminderRunStatus: "error"
        },
        { merge: true }
      );
      await appendAuditLogServer({
        actionType: "reminder.email.error",
        summary: "Reminder run failed",
        meta: { message: e.message || String(e) }
      });
    }
  }
);
