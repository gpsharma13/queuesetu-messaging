import express from "express";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded webhooks

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const CLINIC_ID = process.env.CLINIC_ID;
const DOCTOR_ID = process.env.DOCTOR_ID;

// ---------- Helper: get live queue position for a token ----------
async function getQueuePosition(tokenId, doctorId) {
  const { data: myToken } = await supabase
    .from("tokens")
    .select("*")
    .eq("id", tokenId)
    .single();

  const { data: aheadTokens, error } = await supabase
    .from("tokens")
    .select("id")
    .eq("doctor_id", doctorId)
    .eq("status", "waiting")
    .lt("created_at", myToken.created_at);

  if (error) throw error;
  return aheadTokens.length; // number of patients ahead
}

// ---------- Bilingual message templates ----------
function registrationMessage(tokenNumber, position, lang = "en") {
  if (lang === "hi") {
    return `Aapka token number ${tokenNumber} hai. Aapse pehle ${position} log hain. Hum aapko update karte rahenge.`;
  }
  return `Your token number is ${tokenNumber}. There are ${position} people ahead of you. We'll keep you updated.`;
}

function positionUpdateMessage(position, lang = "en") {
  if (position === 0) {
    return lang === "hi"
      ? "Aapki baari hai! Kripya andar aa jaayein."
      : "You're next! Please come in now.";
  }
  return lang === "hi"
    ? `Update: ab aapse pehle sirf ${position} log hain.`
    : `Update: only ${position} people ahead of you now.`;
}

// ---------- INBOUND: Twilio webhook for incoming WhatsApp messages ----------
app.post("/webhook/whatsapp", async (req, res) => {
  const fromNumber = req.body.From.replace("whatsapp:", ""); // e.g. +919876543210
  const messageBody = (req.body.Body || "").trim();

  try {
    // 1. Find or create patient
    let { data: patient } = await supabase
      .from("patients")
      .select("*")
      .eq("phone", fromNumber)
      .maybeSingle();

    if (!patient) {
      const { data: newPatient, error } = await supabase
        .from("patients")
        .insert({ phone: fromNumber })
        .select()
        .single();
      if (error) throw error;
      patient = newPatient;
    }

    // 2. Check if patient already has an active token today for this doctor
    const { data: existingToken } = await supabase
      .from("tokens")
      .select("*")
      .eq("patient_id", patient.id)
      .eq("doctor_id", DOCTOR_ID)
      .in("status", ["waiting", "in-consultation"])
      .maybeSingle();

    if (existingToken) {
      const position = await getQueuePosition(existingToken.id, DOCTOR_ID);
      await sendWhatsApp(fromNumber, positionUpdateMessage(position));
      return res.status(200).send("OK");
    }

    // 3. Create new token — get next token number for the doctor today
    const { count } = await supabase
      .from("tokens")
      .select("*", { count: "exact", head: true })
      .eq("doctor_id", DOCTOR_ID)
      .gte("created_at", new Date().toISOString().split("T")[0]);

    const tokenNumber = (count || 0) + 1;

    const { data: newToken, error: tokenError } = await supabase
      .from("tokens")
      .insert({
        clinic_id: CLINIC_ID,
        doctor_id: DOCTOR_ID,
        patient_id: patient.id,
        token_number: tokenNumber,
        status: "waiting",
      })
      .select()
      .single();

    if (tokenError) throw tokenError;

    const position = await getQueuePosition(newToken.id, DOCTOR_ID);
    await sendWhatsApp(fromNumber, registrationMessage(tokenNumber, position));

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Error");
  }
});

// ---------- OUTBOUND: send a WhatsApp message via Twilio ----------
async function sendWhatsApp(toNumber, message) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: `whatsapp:${toNumber}`,
    body: message,
  });
}

// ---------- OUTBOUND: notify all waiting patients when queue shifts ----------
// Call this whenever staff marks a token as "in-consultation" or "completed"
// (your partner's dashboard should trigger this, or you can poll every 30s)
async function notifyQueueOnChange(doctorId) {
  const { data: waitingTokens, error } = await supabase
    .from("tokens")
    .select("*, patients(phone)")
    .eq("doctor_id", doctorId)
    .eq("status", "waiting")
    .order("created_at", { ascending: true });

  if (error) throw error;

  for (let i = 0; i < waitingTokens.length; i++) {
    const token = waitingTokens[i];
    await sendWhatsApp(token.patients.phone, positionUpdateMessage(i));
  }
}

// Simple endpoint your partner's dashboard can call after updating a token's status
app.post("/notify-queue-update", express.json(), async (req, res) => {
  const { doctor_id } = req.body;
  try {
    await notifyQueueOnChange(doctor_id);
    res.status(200).send("Notified");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

app.listen(3000, () => console.log("QueueSetu messaging layer running on port 3000"));
