module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check configuration (without exposing sensitive values)
  const config = {
    hasStripeSecretKey: !!process.env.STRIPE_SECRET_KEY,
    hasStripePriceId: !!process.env.STRIPE_PRICE_ID,
    hasStripeWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
    hasFrontendUrl: !!process.env.FRONTEND_URL,
    hasChromeExtensionId: !!process.env.CHROME_EXTENSION_ID,
    hasSupabaseUrl: !!process.env.SUPABASE_URL,
    hasSupabaseServiceKey: !!process.env.SUPABASE_SERVICE_KEY,
    
    // Non-sensitive values
    proCreditsPerMonth: process.env.PRO_CREDITS_PER_MONTH || '200',
    proValidityDays: process.env.PRO_VALIDITY_DAYS || '30',
    proPriceCents: process.env.PRO_PRICE_CENTS || '497',
    topupCredits: process.env.TOPUP_CREDITS || '100',
    topupPriceCents: process.env.TOPUP_PRICE_CENTS || '297',
    frontendUrl: process.env.FRONTEND_URL ? 'Set' : 'Using Chrome Extension ID',
    chromeExtensionId: process.env.CHROME_EXTENSION_ID || 'Not set - using default'
  };

  // Test Stripe connection if key is available
  let stripeStatus = 'Not configured';
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      // Try to list prices to verify API key works
      const prices = await stripe.prices.list({ limit: 1 });
      stripeStatus = 'Connected successfully';
      
      // Check if the configured price ID exists
      if (process.env.STRIPE_PRICE_ID) {
        try {
          const price = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID);
          config.stripePriceIdValid = true;
          config.stripePriceAmount = price.unit_amount;
          config.stripePriceCurrency = price.currency;
        } catch (priceError) {
          config.stripePriceIdValid = false;
          config.stripePriceError = priceError.message;
        }
      }
    } catch (stripeError) {
      stripeStatus = `Error: ${stripeError.message}`;
    }
  }

  return res.status(200).json({
    status: 'Configuration Check',
    timestamp: new Date().toISOString(),
    config,
    stripeStatus,
    recommendations: [
      !config.hasStripeSecretKey && 'Set STRIPE_SECRET_KEY environment variable',
      !config.hasStripePriceId && 'Set STRIPE_PRICE_ID environment variable',
      !config.hasStripeWebhookSecret && 'Set STRIPE_WEBHOOK_SECRET environment variable',
      !config.hasChromeExtensionId && 'Set CHROME_EXTENSION_ID environment variable',
      config.stripePriceIdValid === false && 'STRIPE_PRICE_ID is invalid or does not exist'
    ].filter(Boolean)
  });
};