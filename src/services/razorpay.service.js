import crypto from 'crypto';
import Razorpay from 'razorpay';
import { config } from '../config/index.js';

let client;

function getClient() {
  if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    return null;
  }
  if (!client) {
    client = new Razorpay({
      key_id: config.razorpayKeyId,
      key_secret: config.razorpayKeySecret,
    });
  }
  return client;
}

/** Amount in paise — ₹353 as in mock */
export const DEFAULT_AMOUNT_PAISE = 35300;

export async function createOrder(amountPaise = DEFAULT_AMOUNT_PAISE, receipt = `rcpt_${Date.now()}`) {
  if (
    process.env.ALLOW_FAKE_PAYMENT === 'true' &&
    config.nodeEnv === 'development' &&
    !config.razorpayKeyId
  ) {
    return {
      id: `order_dev_${Date.now()}`,
      amount: amountPaise,
      currency: 'INR',
      receipt,
    };
  }
  const rz = getClient();
  if (!rz) {
    const err = new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    err.statusCode = 503;
    throw err;
  }
  const order = await rz.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt,
    payment_capture: 1,
  });
  return order;
}

export function verifyPaymentSignature(orderId, paymentId, signature) {
  if (
    process.env.ALLOW_FAKE_PAYMENT === 'true' &&
    config.nodeEnv === 'development'
  ) {
    return true;
  }
  if (!config.razorpayKeySecret) return false;
  const body = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', config.razorpayKeySecret).update(body).digest('hex');
  return expected === signature;
}
