import dotenv from 'dotenv';

dotenv.config();

console.log("DB URL:", process.env.DATABASE_URL);
export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
  publicAppUrl: (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
};

export function assertConfig() {
  if (!config.databaseUrl && process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  if (!config.databaseUrl) {
    console.warn('Warning: DATABASE_URL not set. Database operations will fail.');
  }
}
