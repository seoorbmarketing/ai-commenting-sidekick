const { supabaseAdmin } = require('../lib/supabase');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { action } = req.query;

  // Route based on action parameter
  switch (action) {
    case 'stripe-config':
      return handleStripeConfig(req, res);
    case 'webhook-logs':
      return handleWebhookLogs(req, res);
    case 'test-webhook':
      return handleTestWebhook(req, res);
    case 'manual-trigger':
      return handleManualTrigger(req, res);
    default:
      return res.status(200).json({
        endpoints: {
          'stripe-config': '/api/debug?action=stripe-config',
          'webhook-logs': '/api/debug?action=webhook-logs',
          'test-webhook': '/api/debug?action=test-webhook',
          'manual-trigger': '/api/debug?action=manual-trigger'
        }
      });
  }
};

async function handleStripeConfig(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check configuration (without exposing sensitive values)
  const config = {
    hasStripeSecretKey: !!process.env.STRIPE_SECRET_KEY,
    hasStripePriceId: !!process.env.STRIPE_PRICE_ID,
    hasStripeTopupPriceId: !!process.env.STRIPE_TOPUP_PRICE_ID,
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
      
      // Check if the top-up price ID exists
      if (process.env.STRIPE_TOPUP_PRICE_ID) {
        try {
          const topupPrice = await stripe.prices.retrieve(process.env.STRIPE_TOPUP_PRICE_ID);
          config.stripeTopupPriceIdValid = true;
          config.stripeTopupPriceAmount = topupPrice.unit_amount;
          config.stripeTopupPriceCurrency = topupPrice.currency;
        } catch (topupPriceError) {
          config.stripeTopupPriceIdValid = false;
          config.stripeTopupPriceError = topupPriceError.message;
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
      !config.hasStripeTopupPriceId && 'Set STRIPE_TOPUP_PRICE_ID environment variable',
      !config.hasStripeWebhookSecret && 'Set STRIPE_WEBHOOK_SECRET environment variable',
      !config.hasChromeExtensionId && 'Set CHROME_EXTENSION_ID environment variable',
      config.stripePriceIdValid === false && 'STRIPE_PRICE_ID is invalid or does not exist',
      config.stripeTopupPriceIdValid === false && 'STRIPE_TOPUP_PRICE_ID is invalid or does not exist'
    ].filter(Boolean)
  });
}

async function handleWebhookLogs(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get recent subscription history logs
    const { data: logs, error } = await supabaseAdmin
      .from('subscription_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      throw error;
    }

    // Get recent subscriptions
    const { data: subscriptions, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    if (subError) {
      throw subError;
    }

    // Get recent credit purchases
    const { data: purchases, error: purchaseError } = await supabaseAdmin
      .from('credit_purchases')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    if (purchaseError) {
      throw purchaseError;
    }

    return res.status(200).json({
      webhook_logs: logs || [],
      recent_subscriptions: subscriptions || [],
      recent_purchases: purchases || [],
      webhook_config: {
        has_webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
        webhook_url: 'https://ai-commenting-sidekick.automatemybiz.pro/api/stripe-webhook'
      }
    });

  } catch (error) {
    console.error('[Webhook Logs] Error:', error);
    return res.status(500).json({
      error: 'Failed to fetch webhook logs',
      message: error.message
    });
  }
}

async function handleTestWebhook(req, res) {
  if (req.method === 'GET') {
    // Show webhook status
    return res.status(200).json({
      status: 'Webhook Test Endpoint',
      info: 'POST to this endpoint to test webhook processing',
      webhookUrl: 'https://ai-commenting-sidekick.automatemybiz.pro/api/stripe-webhook',
      configStatus: {
        hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
        secretPrefix: process.env.STRIPE_WEBHOOK_SECRET ? process.env.STRIPE_WEBHOOK_SECRET.substring(0, 10) + '...' : 'Not set'
      }
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId, sessionId } = req.body;

    if (!userId || !sessionId) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['userId', 'sessionId']
      });
    }

    console.log('[Test Webhook] Simulating checkout completion for:', { userId, sessionId });

    // Simulate what the webhook would do
    const credits = 200;
    const validityDays = 30;

    // Create subscription record
    const { data: subscription, error: subError } = await supabaseAdmin
      .from('subscriptions')
      .insert([{
        user_id: userId,
        stripe_subscription_id: `test_sub_${Date.now()}`,
        stripe_customer_id: `test_cus_${Date.now()}`,
        stripe_price_id: process.env.STRIPE_PRICE_ID || 'test_price',
        status: 'active',
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString(),
        credits_per_period: credits,
        remaining_credits: 0
      }])
      .select()
      .single();

    if (subError) {
      console.error('[Test Webhook] Failed to create subscription:', subError);
      return res.status(500).json({ 
        error: 'Failed to create subscription',
        details: subError.message 
      });
    }

    // Create credit purchase record
    const { data: creditPurchase, error: creditError } = await supabaseAdmin
      .from('credit_purchases')
      .insert([{
        user_id: userId,
        subscription_id: subscription.id,
        credits: credits,
        remaining_credits: credits,
        amount_paid: 4.97,
        currency: 'usd',
        stripe_payment_intent_id: `test_pi_${Date.now()}`,
        stripe_checkout_session_id: sessionId,
        purchase_type: 'subscription',
        expires_at: subscription.current_period_end,
        payment_status: 'completed'
      }])
      .select()
      .single();

    if (creditError) {
      console.error('[Test Webhook] Failed to create credit purchase:', creditError);
      return res.status(500).json({ 
        error: 'Failed to create credit purchase',
        details: creditError.message 
      });
    }

    // Update user tier
    const { error: userError } = await supabaseAdmin
      .from('users')
      .update({ tier: 'pro' })
      .eq('id', userId);

    if (userError) {
      console.error('[Test Webhook] Failed to update user tier:', userError);
    }

    return res.status(200).json({
      success: true,
      message: 'Test webhook processed successfully',
      subscription: {
        id: subscription.id,
        status: subscription.status,
        credits: credits,
        expires: subscription.current_period_end
      },
      creditPurchase: {
        id: creditPurchase.id,
        credits: creditPurchase.credits,
        remaining: creditPurchase.remaining_credits
      }
    });

  } catch (error) {
    console.error('[Test Webhook] Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}

async function handleManualTrigger(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    console.log('[Manual Trigger] Retrieving session:', sessionId);

    // Retrieve the session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log('[Manual Trigger] Session found:', {
      id: session.id,
      payment_status: session.payment_status,
      status: session.status,
      metadata: session.metadata
    });

    // Check if payment was successful
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ 
        error: 'Payment not completed',
        payment_status: session.payment_status 
      });
    }

    // Extract metadata
    const { 
      user_id: userId, 
      purchase_type: purchaseType,
      credits: metadataCredits,
      validity_days: metadataValidityDays
    } = session.metadata || {};

    if (!userId) {
      return res.status(400).json({ error: 'No user_id in session metadata' });
    }

    // Check if subscription already exists for this session
    const { data: existingPurchase } = await supabaseAdmin
      .from('credit_purchases')
      .select('id')
      .eq('stripe_checkout_session_id', session.id)
      .single();

    if (existingPurchase) {
      return res.status(200).json({ 
        message: 'Subscription already processed for this session',
        purchase_id: existingPurchase.id 
      });
    }

    // Process based on purchase type
    if (purchaseType === 'subscription') {
      // Get credits and validity from metadata or environment
      const credits = parseInt(metadataCredits || process.env.PRO_CREDITS_PER_MONTH || '200');
      const validityDays = parseInt(metadataValidityDays || process.env.PRO_VALIDITY_DAYS || '30');
      
      // Create subscription record
      const { data: subscription, error: subError } = await supabaseAdmin
        .from('subscriptions')
        .insert([{
          user_id: userId,
          stripe_subscription_id: session.subscription || `manual_sub_${Date.now()}`,
          stripe_customer_id: session.customer,
          stripe_price_id: process.env.STRIPE_PRICE_ID,
          status: 'active',
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString(),
          credits_per_period: credits
        }])
        .select()
        .single();

      if (subError) {
        console.error('[Manual Trigger] Failed to create subscription:', subError);
        return res.status(500).json({ 
          error: 'Failed to create subscription',
          details: subError.message 
        });
      }

      // Create credit purchase record
      const { data: creditPurchase, error: creditError } = await supabaseAdmin
        .from('credit_purchases')
        .insert([{
          user_id: userId,
          subscription_id: subscription.id,
          credits: credits,
          remaining_credits: credits,
          amount_paid: session.amount_total / 100,
          currency: session.currency,
          stripe_payment_intent_id: session.payment_intent,
          stripe_checkout_session_id: session.id,
          purchase_type: 'subscription',
          expires_at: subscription.current_period_end,
          payment_status: 'completed'
        }])
        .select()
        .single();

      if (creditError) {
        console.error('[Manual Trigger] Failed to create credit purchase:', creditError);
        return res.status(500).json({ 
          error: 'Failed to create credit purchase',
          details: creditError.message 
        });
      }

      // Update user tier
      await supabaseAdmin
        .from('users')
        .update({ tier: 'pro' })
        .eq('id', userId);

      // Log subscription history
      await supabaseAdmin
        .from('subscription_history')
        .insert([{
          subscription_id: subscription.id,
          user_id: userId,
          event_type: 'created',
          stripe_event_id: `manual_${session.id}`,
          details: { session, manual: true }
        }]);

      return res.status(200).json({
        success: true,
        message: 'Subscription created successfully',
        subscription: {
          id: subscription.id,
          status: subscription.status,
          credits: credits,
          expires: subscription.current_period_end
        },
        creditPurchase: {
          id: creditPurchase.id,
          credits: creditPurchase.credits,
          remaining: creditPurchase.remaining_credits
        }
      });
    } else if (purchaseType === 'topup') {
      // Get credits from metadata or environment
      const credits = parseInt(metadataCredits || process.env.TOPUP_CREDITS || '100');
      
      // Get active subscription
      const { data: activeSubscription } = await supabaseAdmin
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      if (!activeSubscription) {
        return res.status(400).json({ 
          error: 'No active subscription found',
          message: 'Top-ups require an active subscription'
        });
      }

      // Create credit purchase record
      const { data: creditPurchase, error: creditError } = await supabaseAdmin
        .from('credit_purchases')
        .insert([{
          user_id: userId,
          subscription_id: activeSubscription.id,
          credits: credits,
          remaining_credits: credits,
          amount_paid: session.amount_total / 100,
          currency: session.currency,
          stripe_payment_intent_id: session.payment_intent,
          stripe_checkout_session_id: session.id,
          purchase_type: 'topup',
          expires_at: activeSubscription.current_period_end,
          payment_status: 'completed'
        }])
        .select()
        .single();

      if (creditError) {
        console.error('[Manual Trigger] Failed to create top-up credit purchase:', creditError);
        return res.status(500).json({ 
          error: 'Failed to create top-up credit purchase',
          details: creditError.message 
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Top-up credits added successfully',
        creditPurchase: {
          id: creditPurchase.id,
          credits: creditPurchase.credits,
          remaining: creditPurchase.remaining_credits,
          expires_at: creditPurchase.expires_at
        }
      });
    }

    return res.status(400).json({ error: 'Unsupported purchase type' });

  } catch (error) {
    console.error('[Manual Trigger] Error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}