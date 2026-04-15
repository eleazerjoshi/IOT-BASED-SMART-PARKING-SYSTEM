const express = require("express");
const Razorpay = require("razorpay");
const crypto   = require("crypto");
const cors     = require("cors");
const path     = require("path");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Your Razorpay keys ──
const KEY_ID     = "rzp_test_ScsEYOiBEtecBT";
const KEY_SECRET = "1jd6M0ZLyDJCJ37DA4nO27K6";

const razorpay = new Razorpay({
  key_id:     KEY_ID,
  key_secret: KEY_SECRET,
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    const order = await razorpay.orders.create({
      amount:   amount * 100, // convert ₹ to paise
      currency: "INR",
      receipt:  "order_" + Date.now(),
    });
    res.json(order);
  } catch (err) {
    console.error("🔥 Razorpay error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Verify payment signature & return 6-digit OTP ──
app.post("/verify-payment", (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac("sha256", KEY_SECRET)
    .update(body)
    .digest("hex");

  if (expectedSignature === razorpay_signature) {
    // Generate a guaranteed 6-digit OTP (100000–999999, never starts with 0)
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    console.log("✅ Payment verified:", razorpay_payment_id, "| OTP:", otp);
    res.json({ success: true, otp });
  } else {
    console.error("❌ Signature mismatch");
    res.status(400).json({ success: false, message: "Invalid signature" });
  }
});

app.listen(5000, () => {
  console.log("✅ Server running on http://localhost:5000");
  console.log("   Open: http://localhost:5000/index.html");
});