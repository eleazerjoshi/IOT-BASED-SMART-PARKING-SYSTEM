
const express  = require("express");
const Razorpay = require("razorpay");
const crypto   = require("crypto");
const cors     = require("cors");
const path     = require("path");
const dns      = require("dns");
const { MongoClient } = require("mongodb");

// Use public DNS to avoid Atlas connection issues on Render
dns.setServers(["1.1.1.1", "8.8.8.8"]);

// ── MongoDB Atlas ────────────────────────────────────────────────────────────
const MONGO_URL = process.env.MONGO_URL ||
  "mongodb+srv://IOTPROJECT:abcd123@smart.ughebwj.mongodb.net/PARKNOW?retryWrites=true&w=majority&appName=Smart";

const client = new MongoClient(MONGO_URL, {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
});

let slotsCol;     // db.collection("slots")
let bookingsCol;  // db.collection("bookings")
let sessionsCol;  // db.collection("sessions")

// Connect and seed slots
async function connectDB() {
  await client.connect();
  const db  = client.db("PARKNOW");
  slotsCol    = db.collection("slots");
  bookingsCol = db.collection("bookings");
  sessionsCol = db.collection("sessions");

  // Create indexes for fast lookups
  await slotsCol.createIndex({ slot_id: 1 }, { unique: true });
  await bookingsCol.createIndex({ booking_ref: 1 }, { unique: true });
  await bookingsCol.createIndex({ otp: 1 });
  await bookingsCol.createIndex({ status: 1 });
  await sessionsCol.createIndex({ booking_ref: 1 });

  // Seed 6 slots if they don't exist
  const slotIds = ["A1", "A2", "A3", "A4", "A5", "A6"];
  for (const id of slotIds) {
    await slotsCol.updateOne(
      { slot_id: id },
      {
        $setOnInsert: {
          slot_id:     id,
          state:       "free",    // "free" | "booked"
          vehicle_no:  null,
          booking_ref: null,
          updated_at:  new Date(),
        },
      },
      { upsert: true }
    );
  }

  console.log("✅ MongoDB Atlas connected — DB: PARKNOW");
  console.log("   Collections: slots, bookings, sessions");
}

connectDB().catch(err => {
  console.error("❌ MongoDB connection failed:", err.message);
  process.exit(1);
});

// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Razorpay ─────────────────────────────────────────────────────────────────
const KEY_ID     = process.env.RAZORPAY_KEY_ID     || "rzp_test_ScsEYOiBEtecBT";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "1jd6M0ZLyDJCJ37DA4nO27K6";
const razorpay   = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });

// ── Fee calculation ───────────────────────────────────────────────────────────
const RATES = { car: 40, passenger: 60, bike: 20, ev: 50 };
function calcFee(vehicleType, durationMins) {
  const rate  = RATES[vehicleType] || 40;
  const hours = durationMins / 60;
  return Math.max(20, Math.round(hours * rate));
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── GET /slots ────────────────────────────────────────────────────────────────
// Returns all 6 slots with current state from MongoDB.
// Called on page load; frontend syncs slot colours from this.
app.get("/slots", async (req, res) => {
  try {
    const slots = await slotsCol
      .find({}, { projection: { _id: 0 } })
      .sort({ slot_id: 1 })
      .toArray();
    res.json({ success: true, slots });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /create-booking ──────────────────────────────────────────────────────
// Step 1: save a pending booking document in MongoDB.
// Body: { slot_id, vehicle_no, vehicle_type, duration_hrs, rate_per_hr,
//         parking_fee, total_amount }
app.post("/create-booking", async (req, res) => {
  const {
    slot_id, vehicle_no, vehicle_type,
    duration_hrs, rate_per_hr, parking_fee, total_amount,
  } = req.body;

  if (!slot_id || !vehicle_no || !vehicle_type || !duration_hrs || !total_amount) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    // Server-side slot availability check
    const slot = await slotsCol.findOne({ slot_id });
    if (!slot)
      return res.status(404).json({ success: false, message: `Slot ${slot_id} not found.` });
    if (slot.state !== "free")
      return res.status(409).json({ success: false, message: `Slot ${slot_id} is already booked. Please pick another.` });

    const booking_ref = "2026-" + String(Math.floor(1000 + Math.random() * 9000));

    // Insert booking document — status starts as "pending"
    await bookingsCol.insertOne({
      booking_ref,
      slot_id,
      vehicle_no:          vehicle_no.toUpperCase(),
      vehicle_type,
      duration_hrs,
      rate_per_hr,
      parking_fee,
      service_fee:         10,
      total_amount,
      status:              "pending",    // pending → active → completed
      otp:                 null,         // 6-digit number stored here after payment
      razorpay_order_id:   null,
      razorpay_payment_id: null,
      created_at:          new Date(),
      paid_at:             null,
      entry_time:          null,
      exit_time:           null,
    });

    console.log(`📋 Booking #PN-${booking_ref} | Slot ${slot_id} | ${vehicle_no}`);
    res.json({ success: true, booking_ref });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /create-order ────────────────────────────────────────────────────────
// Step 2: create a Razorpay order and save the order ID to the booking.
app.post("/create-order", async (req, res) => {
  const { amount, booking_ref } = req.body;
  try {
    const order = await razorpay.orders.create({
      amount:   Math.round(amount * 100),  // paise
      currency: "INR",
      receipt:  "order_" + Date.now(),
    });

    // Attach Razorpay order ID to our booking record
    if (booking_ref) {
      await bookingsCol.updateOne(
        { booking_ref },
        { $set: { razorpay_order_id: order.id } }
      );
    }

    res.json(order);
  } catch (err) {
    console.error("🔥 Razorpay:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /verify-payment ──────────────────────────────────────────────────────
// Step 3: verify Razorpay HMAC signature, generate a 6-digit OTP,
// save it to MongoDB, and mark the slot as booked.
// The OTP is the number users show at the entry barrier.
app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking_ref } = req.body;

  // 1. Verify Razorpay HMAC
  const hmacBody    = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSig = crypto
    .createHmac("sha256", KEY_SECRET)
    .update(hmacBody)
    .digest("hex");

  if (expectedSig !== razorpay_signature) {
    console.error("❌ Signature mismatch");
    return res.status(400).json({ success: false, message: "Invalid payment signature." });
  }

  try {
    // 2. Look up the booking
    const booking = await bookingsCol.findOne({ booking_ref });
    if (!booking)
      return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "pending")
      return res.status(409).json({ success: false, message: "Booking already processed." });

    // 3. Generate 6-digit OTP and save to MongoDB
    //    This is the number the user will verify at the barrier
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const now = new Date();

    // 4. Update booking: status = active, save OTP + payment info
    await bookingsCol.updateOne(
      { booking_ref },
      {
        $set: {
          status:              "active",
          otp,                           // ← 6-digit OTP stored in DB
          razorpay_payment_id,
          paid_at:             now,
          entry_time:          now,
        },
      }
    );

    // 5. Mark the slot as booked in MongoDB
    await slotsCol.updateOne(
      { slot_id: booking.slot_id },
      {
        $set: {
          state:      "booked",
          vehicle_no: booking.vehicle_no,
          booking_ref,
          updated_at: now,
        },
      }
    );

    console.log(`✅ Payment OK | #PN-${booking_ref} | OTP: ${otp} | Slot: ${booking.slot_id} | Payment: ${razorpay_payment_id}`);
    res.json({ success: true, otp, booking_ref, slot_id: booking.slot_id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /verify-otp ──────────────────────────────────────────────────────────
// Entry barrier endpoint. User presents their 6-digit OTP.
// System looks it up in MongoDB and confirms the booking is valid.
// Body: { otp }
app.post("/verify-otp", async (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ success: false, message: "OTP is required." });

  try {
    // Find the active booking that has this exact OTP in MongoDB
    const booking = await bookingsCol.findOne({
      otp:    String(otp).trim(),
      status: "active",
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Invalid OTP or booking already closed.",
      });
    }

    res.json({
      success:      true,
      message:      "OTP verified. Entry granted.",
      booking_ref:  booking.booking_ref,
      slot_id:      booking.slot_id,
      vehicle_no:   booking.vehicle_no,
      vehicle_type: booking.vehicle_type,
      duration_hrs: booking.duration_hrs,
      entry_time:   booking.entry_time,
      total_amount: booking.total_amount,
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /exit ────────────────────────────────────────────────────────────────
// Exit flow. User presents their OTP at exit barrier.
// System validates, calculates fee, frees the slot, writes a session record.
// Body: { otp }
app.post("/exit", async (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ success: false, message: "OTP is required." });

  try {
    // Find active booking by OTP from MongoDB
    const booking = await bookingsCol.findOne({
      otp:    String(otp).trim(),
      status: "active",
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "OTP not found or already used for exit.",
      });
    }

    // Calculate actual duration and fee
    const entryMs      = booking.entry_time ? new Date(booking.entry_time).getTime() : Date.now();
    const durationMins = Math.max(1, Math.ceil((Date.now() - entryMs) / 60000));
    const fee          = calcFee(booking.vehicle_type, durationMins);
    const now          = new Date();

    // Mark booking completed in MongoDB
    await bookingsCol.updateOne(
      { booking_ref: booking.booking_ref },
      {
        $set: {
          status:               "completed",
          exit_time:            now,
          actual_duration_mins: durationMins,
          exit_fee:             fee,
        },
      }
    );

    // Free the slot in MongoDB
    await slotsCol.updateOne(
      { slot_id: booking.slot_id },
      {
        $set: {
          state:      "free",
          vehicle_no:  null,
          booking_ref: null,
          updated_at:  now,
        },
      }
    );

    // Write an immutable session record for history and billing
    await sessionsCol.insertOne({
      booking_ref:   booking.booking_ref,
      otp:           booking.otp,
      slot_id:       booking.slot_id,
      vehicle_no:    booking.vehicle_no,
      vehicle_type:  booking.vehicle_type,
      entry_time:    booking.entry_time,
      exit_time:     now,
      duration_mins: durationMins,
      fee,
      total_paid:    booking.total_amount,
      extra_charge:  Math.max(0, fee - booking.total_amount),
      created_at:    now,
    });

    console.log(`🚗 Exit | #PN-${booking.booking_ref} | Slot: ${booking.slot_id} | Duration: ${durationMins}m | Fee: ₹${fee}`);

    res.json({
      success:       true,
      booking_ref:   booking.booking_ref,
      slot_id:       booking.slot_id,
      vehicle_no:    booking.vehicle_no,
      duration_mins: durationMins,
      fee,
      total_paid:    booking.total_amount,
      extra_charge:  Math.max(0, fee - booking.total_amount),
      message:       `Exit confirmed. Slot ${booking.slot_id} is now free. Fee: ₹${fee}.`,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /bookings ──────────────────────────────────────────────────────────────
// Returns all active bookings (for live panel / admin dashboard).
app.get("/bookings", async (req, res) => {
  try {
    const bookings = await bookingsCol
      .find({ status: { $in: ["active", "pending"] } }, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .toArray();
    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /sessions ──────────────────────────────────────────────────────────────
// Returns completed session history (admin / analytics).
app.get("/sessions", async (req, res) => {
  try {
    const sessions = await sessionsCol
      .find({}, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /release-slot ─────────────────────────────────────────────────────────
// Admin override — manually free any slot.
app.post("/release-slot", async (req, res) => {
  const { slot_id } = req.body;
  if (!slot_id) return res.status(400).json({ success: false, message: "slot_id required." });
  await slotsCol.updateOne(
    { slot_id },
    { $set: { state: "free", vehicle_no: null, booking_ref: null, updated_at: new Date() } }
  );
  console.log(`🔓 Slot ${slot_id} manually released`);
  res.json({ success: true, message: `Slot ${slot_id} is now free.` });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ ParkNow server on port ${PORT}`);
  console.log(`   GET  /slots          → all slot states`);
  console.log(`   POST /create-booking → save pending booking`);
  console.log(`   POST /create-order   → create Razorpay order`);
  console.log(`   POST /verify-payment → verify payment, save OTP to DB`);
  console.log(`   POST /verify-otp     → validate OTP at entry barrier`);
  console.log(`   POST /exit           → validate OTP at exit, free slot`);
  console.log(`   GET  /bookings       → live active bookings`);
  console.log(`   GET  /sessions       → completed session history`);
});