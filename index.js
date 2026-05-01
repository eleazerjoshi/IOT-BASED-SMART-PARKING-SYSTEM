const express  = require("express");
const Razorpay = require("razorpay");
const crypto   = require("crypto");
const cors     = require("cors");
const path     = require("path");
const dns      = require("dns");
const { MongoClient } = require("mongodb");

dns.setServers(["1.1.1.1", "8.8.8.8"]);

const MONGO_URL = process.env.MONGO_URL ||
  "mongodb+srv://IOTPROJECT:abcd123@smart.ughebwj.mongodb.net/PARKNOW?retryWrites=true&w=majority&appName=Smart";

const client = new MongoClient(MONGO_URL, {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
});

let slotsCol;
let bookingsCol;
let sessionsCol;

async function connectDB() {
  await client.connect();
  const db  = client.db("PARKNOW");
  slotsCol    = db.collection("slots");
  bookingsCol = db.collection("bookings");
  sessionsCol = db.collection("sessions");

  await slotsCol.createIndex({ slot_id: 1 }, { unique: true });
  await bookingsCol.createIndex({ booking_ref: 1 }, { unique: true });
  await bookingsCol.createIndex({ otp: 1 });
  await bookingsCol.createIndex({ status: 1 });
  await sessionsCol.createIndex({ booking_ref: 1 });

  const slotIds = ["A1", "A2", "A3", "A4", "A5", "A6"];
  for (const id of slotIds) {
    await slotsCol.updateOne(
      { slot_id: id },
      {
        $setOnInsert: {
          slot_id:     id,
          state:       "free",
          vehicle_no:  null,
          booking_ref: null,
          updated_at:  new Date(),
        },
      },
      { upsert: true }
    );
  }

  console.log("✅ MongoDB Atlas connected — DB: PARKNOW");
}

connectDB().catch(err => {
  console.error("❌ MongoDB connection failed:", err.message);
  process.exit(1);
});

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const KEY_ID     = process.env.RAZORPAY_KEY_ID     || "rzp_test_ScsEYOiBEtecBT";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "1jd6M0ZLyDJCJ37DA4nO27K6";
const razorpay   = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });

const RATES = { car: 40, passenger: 60, bike: 20, ev: 50 };

// ── GET / ─────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── GET /slots ────────────────────────────────────────────────────────────────
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
app.post("/create-booking", async (req, res) => {
  const { slot_id, vehicle_no, vehicle_type, duration_hrs, rate_per_hr, parking_fee, total_amount } = req.body;

  if (!slot_id || !vehicle_no || !vehicle_type || !duration_hrs || !total_amount)
    return res.status(400).json({ success: false, message: "Missing required fields." });

  try {
    const slot = await slotsCol.findOne({ slot_id });
    if (!slot)
      return res.status(404).json({ success: false, message: `Slot ${slot_id} not found.` });
    if (slot.state !== "free")
      return res.status(409).json({ success: false, message: `Slot ${slot_id} is already booked. Please pick another.` });

    const booking_ref = "2026-" + String(Math.floor(1000 + Math.random() * 9000));

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
      status:              "pending",
      otp:                 null,
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
app.post("/create-order", async (req, res) => {
  const { amount, booking_ref } = req.body;
  try {
    const order = await razorpay.orders.create({
      amount:   Math.round(amount * 100),
      currency: "INR",
      receipt:  "order_" + Date.now(),
    });
    if (booking_ref) {
      await bookingsCol.updateOne({ booking_ref }, { $set: { razorpay_order_id: order.id } });
    }
    res.json(order);
  } catch (err) {
    console.error("🔥 Razorpay:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /verify-payment ──────────────────────────────────────────────────────
app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking_ref } = req.body;

  const hmacBody    = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSig = crypto.createHmac("sha256", KEY_SECRET).update(hmacBody).digest("hex");

  if (expectedSig !== razorpay_signature)
    return res.status(400).json({ success: false, message: "Invalid payment signature." });

  try {
    const booking = await bookingsCol.findOne({ booking_ref });
    if (!booking)
      return res.status(404).json({ success: false, message: "Booking not found." });
    if (booking.status !== "pending")
      return res.status(409).json({ success: false, message: "Booking already processed." });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const now = new Date();

    await bookingsCol.updateOne(
      { booking_ref },
      { $set: { status: "active", otp, razorpay_payment_id, paid_at: now, entry_time: now } }
    );

    await slotsCol.updateOne(
      { slot_id: booking.slot_id },
      { $set: { state: "booked", vehicle_no: booking.vehicle_no, booking_ref, updated_at: now } }
    );

    console.log(`✅ Payment OK | #PN-${booking_ref} | OTP: ${otp} | Slot: ${booking.slot_id}`);
    res.json({ success: true, otp, booking_ref, slot_id: booking.slot_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /verify-otp ──────────────────────────────────────────────────────────
// Hardware entry barrier — verifies OTP
app.post("/verify-otp", async (req, res) => {
  const { otp } = req.body;
  if (!otp) return res.status(400).json({ success: false, message: "OTP is required." });

  try {
    const booking = await bookingsCol.findOne({ otp: String(otp).trim(), status: "active" });
    if (!booking)
      return res.status(404).json({ success: false, message: "Invalid OTP or booking already closed." });

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

// ── GET /bookings ─────────────────────────────────────────────────────────────
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

// ── GET /sessions ─────────────────────────────────────────────────────────────
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

// ── GET /exit-info/:slot_id ───────────────────────────────────────────────────
// Called when user clicks the Exit button on a booked slot card.
// Looks up the active booking for that slot — no OTP needed from frontend.
// Returns session duration, extra time, and extra fee for the exit modal.
app.get("/exit-info/:slot_id", async (req, res) => {
  const { slot_id } = req.params;
  try {
    const booking = await bookingsCol.findOne({ slot_id, status: "active" });
    if (!booking)
      return res.status(404).json({ success: false, message: `No active booking found for slot ${slot_id}.` });

    const now                = new Date();
    const entryTime          = booking.entry_time ? new Date(booking.entry_time) : now;
    const actualDurationMins = Math.max(0, Math.floor((now - entryTime) / 60000));
    const bookedDurationMins = booking.duration_hrs * 60;
    const overMins           = Math.max(0, actualDurationMins - bookedDurationMins);
    const rate               = RATES[booking.vehicle_type] || 40;
    const extraFee           = overMins > 0 ? Math.max(20, Math.round((overMins / 60) * rate)) : 0;

    res.json({
      success:              true,
      booking_ref:          booking.booking_ref,
      slot_id:              booking.slot_id,
      vehicle_no:           booking.vehicle_no,
      vehicle_type:         booking.vehicle_type,
      entry_time:           entryTime,
      booked_duration_hrs:  booking.duration_hrs,
      actual_duration_hrs:  Math.floor(actualDurationMins / 60),
      actual_duration_mins: actualDurationMins % 60,
      paid_amount:          booking.total_amount,
      extra_fee:            extraFee,
      total_due:            booking.total_amount + extraFee,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /create-extra-order ──────────────────────────────────────────────────
app.post("/create-extra-order", async (req, res) => {
  const { amount, booking_ref } = req.body;
  try {
    const order = await razorpay.orders.create({
      amount:   Math.round(amount * 100),
      currency: "INR",
      receipt:  "extra_" + Date.now(),
    });
    if (booking_ref) {
      await bookingsCol.updateOne({ booking_ref }, { $set: { extra_razorpay_order_id: order.id } });
    }
    res.json(order);
  } catch (err) {
    console.error("🔥 Extra order:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /verify-extra-payment ────────────────────────────────────────────────
app.post("/verify-extra-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking_ref } = req.body;

  const hmacBody    = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSig = crypto.createHmac("sha256", KEY_SECRET).update(hmacBody).digest("hex");

  if (expectedSig !== razorpay_signature)
    return res.status(400).json({ success: false, message: "Invalid payment signature." });

  try {
    const booking = await bookingsCol.findOne({ booking_ref });
    if (!booking)
      return res.status(404).json({ success: false, message: "Booking not found." });

    const newOtp = String(Math.floor(100000 + Math.random() * 900000));

    await bookingsCol.updateOne(
      { booking_ref },
      {
        $set: {
          extra_razorpay_payment_id: razorpay_payment_id,
          extra_paid:    true,
          extra_paid_at: new Date(),
          exit_otp:      newOtp,
        },
      }
    );

    console.log(`✅ Extra payment OK | #PN-${booking_ref} | Exit OTP: ${newOtp}`);
    res.json({ success: true, booking_ref, new_otp: newOtp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /process-exit ────────────────────────────────────────────────────────
// Frees the slot, marks booking completed, writes session record.
app.post("/process-exit", async (req, res) => {
  const { booking_ref, new_otp } = req.body;

  try {
    const booking = await bookingsCol.findOne({ booking_ref });
    if (!booking)
      return res.status(404).json({ success: false, message: "Booking not found." });

    const now                = new Date();
    const entryTime          = booking.entry_time ? new Date(booking.entry_time) : now;
    const actualDurationMins = Math.max(0, Math.floor((now - entryTime) / 60000));
    const actualDurationHrs  = Math.floor(actualDurationMins / 60);
    const remainingMins      = actualDurationMins % 60;

    await slotsCol.updateOne(
      { slot_id: booking.slot_id },
      { $set: { state: "free", vehicle_no: null, booking_ref: null, updated_at: now } }
    );

    await bookingsCol.updateOne(
      { booking_ref },
      { $set: { status: "completed", exit_time: now, actual_duration_mins: actualDurationMins } }
    );

    const totalPaid = booking.total_amount + (booking.extra_fee || 0);
    await sessionsCol.insertOne({
      booking_ref,
      slot_id:              booking.slot_id,
      vehicle_no:           booking.vehicle_no,
      vehicle_type:         booking.vehicle_type,
      booked_duration_hrs:  booking.duration_hrs,
      actual_duration_mins: actualDurationMins,
      original_amount:      booking.total_amount,
      extra_fee:            booking.extra_fee || 0,
      total_paid:           totalPaid,
      entry_time:           entryTime,
      exit_time:            now,
      otp_used:             new_otp || booking.otp,
      payment_id:           booking.razorpay_payment_id,
      extra_payment_id:     booking.extra_razorpay_payment_id || null,
      created_at:           now,
    });

    console.log(`🚗 Exit | #PN-${booking_ref} | Slot ${booking.slot_id} freed | ${actualDurationHrs}h ${remainingMins}m | ₹${totalPaid}`);

    res.json({
      success:        true,
      booking_ref,
      slot_id:        booking.slot_id,
      total_duration: `${actualDurationHrs} hrs ${remainingMins} mins`,
      total_paid:     totalPaid,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /release-slot ────────────────────────────────────────────────────────
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

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ ParkNow server on port ${PORT}`);
  console.log(`   GET  /slots                → all slot states`);
  console.log(`   POST /create-booking       → save pending booking`);
  console.log(`   POST /create-order         → create Razorpay order`);
  console.log(`   POST /verify-payment       → verify payment, save OTP`);
  console.log(`   POST /verify-otp           → hardware entry barrier`);
  console.log(`   GET  /bookings             → live active bookings`);
  console.log(`   GET  /sessions             → completed session history`);
  console.log(`   GET  /exit-info/:slot_id   → exit modal data by slot`);
  console.log(`   POST /create-extra-order   → overstay Razorpay order`);
  console.log(`   POST /verify-extra-payment → verify overstay payment`);
  console.log(`   POST /process-exit         → free slot + write session`);
});
